/**
 * Claude CLI transcript registry lookups.
 *
 * The CLI keeps one directory per workspace under `~/.claude/projects/`, named
 * by lossily encoding the *resolved* cwd (every non-alphanumeric char → `-`),
 * with one `<session-id>.jsonl` transcript per session inside it. Both flags the
 * adapter can pass depend on what lives there:
 *
 *  - `--resume <id>` needs the transcript under *this* cwd's dir, or the CLI
 *    fails with "No conversation found".
 *  - `--session-id <id>` needs the id to be unused *anywhere*, or the CLI fails
 *    with "Session ID … is already in use." and exits 1.
 *
 * Both probes are permissive on uncertainty: an unreadable registry must never
 * block an otherwise legitimate spawn.
 */

import { existsSync, readdirSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ClaudeModelUsageSnapshot } from '../../../shared/types/provider-model-usage.types';

/** Root of the CLI's per-workspace transcript store. */
function projectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Project dirs the CLI could have written this cwd's transcripts under. A
 * workspace reached through a symlink (`/tmp` → `/private/tmp`, a symlinked
 * repo root) encodes differently from the path we were handed, so both the
 * given and the resolved path are candidates.
 */
function candidateProjectDirs(cwd: string): string[] {
  const paths = new Set([cwd]);
  try {
    paths.add(realpathSync(cwd));
  } catch {
    // Unresolvable cwd — the raw encoding is the only candidate.
  }
  return [...paths].map((p) => join(projectsRoot(), p.replace(/[^a-zA-Z0-9]/g, '-')));
}

/** Whether `--resume <sessionId>` can find a transcript from this cwd. */
export function nativeTranscriptExists(cwd: string | undefined, sessionId: string): boolean {
  if (!cwd) return true;
  try {
    return candidateProjectDirs(cwd).some((dir) => existsSync(join(dir, `${sessionId}.jsonl`)));
  } catch {
    return true;
  }
}

/** Whether the CLI already owns a transcript for this id under *any* workspace. */
export function nativeSessionIdInUse(sessionId: string): boolean {
  try {
    const root = projectsRoot();
    return readdirSync(root, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(root, entry.name, `${sessionId}.jsonl`)),
    );
  } catch {
    // Can't tell — assume free, matching this module's permissive default.
    return false;
  }
}

export interface ClaudeCostState {
  totalCostUSD: number;
  modelUsage?: ClaudeModelUsageSnapshot;
}

/** Read only the bounded tail, tolerating corrupt/partial final records and symlinked cwd. */
export function readLastClaudeCostState(cwd: string | undefined, sessionId: string,
  configDir?: string): ClaudeCostState | undefined {
  if (!cwd || !sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return undefined;
  for (const defaultDir of candidateProjectDirs(cwd)) {
    const dir = configDir ? join(configDir, 'projects', defaultDir.split(/[\\/]/).at(-1)!) : defaultDir;
    let fd: number | undefined;
    try {
      fd = openSync(join(dir, `${sessionId}.jsonl`), 'r');
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - 256 * 1024);
      const buffer = Buffer.alloc(size - start);
      const bytes = readSync(fd, buffer, 0, buffer.length, start);
      let tail = buffer.subarray(0, bytes).toString('utf8');
      if (start > 0) tail = tail.includes('\n') ? tail.slice(tail.indexOf('\n') + 1) : '';
      for (const line of tail.split('\n').reverse()) {
        try {
          const record: unknown = JSON.parse(line);
          if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
          const state = record as Record<string, unknown>;
          const total = state['totalCostUSD'];
          if (state['type'] !== 'cost-state' || typeof total !== 'number' || !Number.isFinite(total) || total < 0) continue;
          const models = state['modelUsage'];
          if (models !== undefined && !validModelUsage(models)) continue;
          return { totalCostUSD: total, ...(models ? { modelUsage: models as ClaudeModelUsageSnapshot } : {}) };
        } catch { /* malformed or partial last line: continue to the preceding record */ }
      }
    } catch { /* missing/unreadable transcript: try the resolved cwd */ }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* fail soft */ } } }
  }
  return undefined;
}

function validModelUsage(models: unknown): models is ClaudeModelUsageSnapshot {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return false;
  const keys = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD'];
  return Object.values(models).every(usage => usage && typeof usage === 'object' && !Array.isArray(usage)
    && keys.every(key => { const value = (usage as Record<string, unknown>)[key];
      return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0); }));
}
