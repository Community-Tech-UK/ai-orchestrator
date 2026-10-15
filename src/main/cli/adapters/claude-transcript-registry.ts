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

import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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

/** Read only the bounded transcript tail. Unreadable/unknown shapes leave the resume cost unknown. */
export function readLastClaudeCostState(cwd: string | undefined, sessionId: string): { totalCostUSD: number; modelUsage?: Record<string, unknown> } | undefined {
  if (!cwd || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return undefined;
  for (const dir of candidateProjectDirs(cwd)) {
    let fd: number | undefined;
    try {
      fd = openSync(join(dir, `${sessionId}.jsonl`), 'r');
      const size = fstatSync(fd).size;
      const length = Math.min(size, 256 * 1024);
      const bytes = Buffer.alloc(length); readSync(fd, bytes, 0, length, size - length);
      const lines = bytes.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const row = JSON.parse(lines[i]) as Record<string, unknown>;
          if (row['type'] === 'cost-state' && typeof row['totalCostUSD'] === 'number' && Number.isFinite(row['totalCostUSD']) && row['totalCostUSD'] >= 0) {
            return { totalCostUSD: row['totalCostUSD'], ...(row['modelUsage'] && typeof row['modelUsage'] === 'object' ? { modelUsage: row['modelUsage'] as Record<string, unknown> } : {}) };
          }
        } catch { /* Partial or non-JSON lines are not cost records. */ }
      }
    } catch { /* Fail soft to token pricing. */ }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Seed lookup stays fail-soft. */ } } }
  }
  return undefined;
}
