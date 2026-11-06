/**
 * Reads Claude Code's own running cost out of its session transcripts.
 *
 * The CLI appends `{"type":"cost-state","totalCostUSD":…}` when a process ends.
 * That total covers the whole session including helper agents, so it is the
 * independent figure Harness's cost store is checked against. A total is only
 * trusted when it is final: if conversation records, or anything unreadable such as a
 * half-written line, follow the last cost-state, the session is still running (or was
 * killed mid-turn) and the figure is stale.
 *
 * Everything here is async and bounded (tail reads only) because it runs inside
 * the main process; no message content is returned or logged.
 */

import { readdirSync } from 'fs';
import { open, readdir, realpath } from 'fs/promises';
import { join } from 'path';

export type ClaudeCostStateRead =
  | { kind: 'settled'; totalCostUSD: number; hasUnknownModelCost: boolean }
  | { kind: 'unsettled' }
  | { kind: 'missing' };

/** Record types that mean the conversation went on (and may have spent money) after the last cost-state. */
const ACTIVITY_TYPES = new Set(['user', 'assistant', 'system', 'api-request', 'api-request-blob']);

export const COST_STATE_TAIL_BYTES = 1024 * 1024;

/**
 * Last valid cost-state in a bounded tail of one transcript.
 *
 * `missing`: nothing usable and the whole file was read, or it cannot be read.
 * `unsettled`: conversation records follow the last cost-state, or the file is
 * larger than the tail and the tail holds none (the real one is out of reach).
 */
export async function readSettledCostState(
  file: string,
  tailBytes: number = COST_STATE_TAIL_BYTES,
): Promise<ClaudeCostStateRead> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    // A tail read can begin mid-record; drop the partial first line.
    if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    let activityAfter = false;
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
      const raw = lines[index];
      if (!raw.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(raw); } catch {
        // Content we cannot read after the last cost-state may be a reply still being written.
        activityAfter = true;
        continue;
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) { activityAfter = true; continue; }
      const fields = record as Record<string, unknown>;
      const type = fields['type'];
      if (type !== 'cost-state') {
        if (typeof type === 'string' && ACTIVITY_TYPES.has(type)) activityAfter = true;
        continue;
      }
      const total = fields['totalCostUSD'];
      if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) continue;
      if (activityAfter) return { kind: 'unsettled' };
      return { kind: 'settled', totalCostUSD: total, hasUnknownModelCost: fields['hasUnknownModelCost'] === true };
    }
    // No usable record in what was read: out of reach if the file continues before the tail, otherwise genuinely absent.
    return start > 0 ? { kind: 'unsettled' } : { kind: 'missing' };
  } catch {
    return { kind: 'missing' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface ClaudeTranscriptRootOptions {
  homeDir: string;
  /** Harness's user-data folder, which holds one folder per signed-in account profile. */
  userDataPath: string;
  profilesDirName: string;
  /** A `CLAUDE_CONFIG_DIR` the app itself was started with, if any. */
  configDir?: string;
}

/** Every `projects` folder Claude Code may have written transcripts to for this user. */
export function claudeTranscriptRoots(options: ClaudeTranscriptRootOptions): string[] {
  const roots = [join(options.homeDir, '.claude', 'projects')];
  if (options.configDir) roots.push(join(options.configDir, 'projects'));
  try {
    const profiles = join(options.userDataPath, options.profilesDirName);
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(profiles, entry.name, 'projects'));
    }
  } catch { /* no account profiles yet */ }
  return roots;
}

/**
 * Session id -> main transcript path, across every projects root.
 *
 * Account profiles often link their `projects` folder to the shared one, so roots
 * are resolved to real paths first and each folder is read once. Helper-agent
 * files live in `<session>/subagents/` and are not indexed: their spend is already
 * inside the parent session's total.
 */
export async function indexClaudeTranscripts(roots: readonly string[]): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const seen = new Set<string>();
  for (const root of roots) {
    let resolved: string;
    try { resolved = await realpath(root); } catch { continue; }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    let projects: import('fs').Dirent[];
    try { projects = await readdir(resolved, { withFileTypes: true }); } catch { continue; }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const folder = join(resolved, project.name);
      let entries: import('fs').Dirent[];
      try { entries = await readdir(folder, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) index.set(entry.name.slice(0, -'.jsonl'.length), join(folder, entry.name));
      }
    }
  }
  return index;
}
