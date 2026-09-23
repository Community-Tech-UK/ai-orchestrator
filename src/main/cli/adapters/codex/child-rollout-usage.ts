import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { defaultDriverFactory } from '../../../db/better-sqlite3-driver';
import type { SqliteDriverFactory } from '../../../db/sqlite-driver';
import { getAioCodexStateDir, getAioCodexSessionsDir } from './codex-home-manager';
import { persistentRolloutPathFor } from './codex-state-leak-snapshot';

export interface ChildRolloutUsage {
  threadId: string;
  usage: Record<string, unknown>;
  baseline?: Record<string, unknown>;
}

export interface ChildRolloutUsageOptions {
  dbPath?: string;
  sessionsDir?: string;
  driverFactory?: SqliteDriverFactory;
  /** Native rollout events without root_turn_id are attributed to this active root-turn window. */
  startedAtMs?: number;
  endedAtMs?: number;
  /** Read receipts only through this time; retries can include a late receipt from an already started child task. */
  observedAtMs?: number;
}

/** The private Codex spawn graph proves parentage even when app-server omits child notifications. */
export async function readChildRolloutUsage(
  rootThreadId: string,
  rootTurnId: string,
  options: ChildRolloutUsageOptions = {},
): Promise<ChildRolloutUsage[]> {
  const dbPath = options.dbPath ?? join(getAioCodexStateDir(), 'state_5.sqlite');
  if (!existsSync(dbPath)) return [];
  let rows: { threadId: string; rolloutPath: string }[];
  try {
    const db = (options.driverFactory ?? defaultDriverFactory)(dbPath, { readonly: true });
    try {
      rows = db.prepare(`
        WITH RECURSIVE descendants(id) AS (
          SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?
          UNION
          SELECT edge.child_thread_id FROM thread_spawn_edges edge
          JOIN descendants ON edge.parent_thread_id = descendants.id
        )
        SELECT threads.id AS threadId, threads.rollout_path AS rolloutPath
        FROM descendants JOIN threads ON threads.id = descendants.id
      `).all<{ threadId: string; rolloutPath: string }>(rootThreadId);
    } finally {
      db.close();
    }
  } catch {
    // Older Codex databases may not have spawn edges. App-server notifications remain available.
    return [];
  }

  const found: ChildRolloutUsage[] = [];
  for (const row of rows) {
    const persistent = persistentRolloutPathFor(row.rolloutPath, options.sessionsDir ?? getAioCodexSessionsDir());
    const path = existsSync(row.rolloutPath) ? row.rolloutPath : persistent;
    if (!path || !existsSync(path)) continue;
    // A file untouched since before this root turn cannot contain its usage.
    if (options.startedAtMs !== undefined) {
      try { if (statSync(path).mtimeMs < options.startedAtMs - 2_000) continue; }
      catch { continue; }
    }
    const result = await usageForRootTurn(path, rootTurnId, options.startedAtMs, options.endedAtMs, options.observedAtMs ?? Date.now());
    if (result) found.push({ threadId: row.threadId, ...result });
  }
  return found;
}

async function usageForRootTurn(
  path: string,
  rootTurnId: string,
  startedAtMs?: number,
  endedAtMs?: number,
  observedAtMs = Date.now(),
): Promise<{ usage: Record<string, unknown>; baseline?: Record<string, unknown> } | null> {
  let latestExplicit: Record<string, unknown> | null = null;
  let explicitUsage: Record<string, unknown> | null = null;
  let explicitBaseline: Record<string, unknown> | null = null;
  let latestTimed: Record<string, unknown> | null = null;
  let timedUsage: Record<string, unknown> | null = null;
  let timedBaseline: Record<string, unknown> | null = null;
  let activeTaskStartedInWindow = false;
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const payload = record(entry['payload']);
        const timestamp = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : Number.NaN;
        if (entry['type'] === 'event_msg' && payload?.['type'] === 'task_started') {
          activeTaskStartedInWindow = startedAtMs !== undefined && endedAtMs !== undefined
            && Number.isFinite(timestamp) && timestamp >= startedAtMs && timestamp <= endedAtMs;
        }
        if (entry['type'] === 'token_usage_record') {
          const candidate = record(payload?.['thread_token_usage']);
          if (!candidate || !validUsage(candidate)) continue;
          if (payload?.['root_turn_id'] === rootTurnId) {
            if (!explicitUsage) explicitBaseline = latestExplicit;
            explicitUsage = candidate;
          }
          latestExplicit = candidate;
        } else if (entry['type'] === 'event_msg' && payload?.['type'] === 'token_count') {
          const candidate = record(record(payload['info'])?.['total_token_usage']);
          if (!candidate || !validUsage(candidate)) continue;
          if (startedAtMs !== undefined && endedAtMs !== undefined
            && Number.isFinite(timestamp) && timestamp <= observedAtMs
            && (activeTaskStartedInWindow || timestamp >= startedAtMs && timestamp <= endedAtMs)) {
            if (!timedUsage) timedBaseline = latestTimed;
            timedUsage = candidate;
          }
          latestTimed = candidate;
        }
      } catch { /* Incomplete or malformed rollout line. */ }
    }
  } catch { /* A concurrently removed or unreadable rollout is retried at the next boundary. */ }
  if (explicitUsage) return { usage: explicitUsage, ...(explicitBaseline ? { baseline: explicitBaseline } : {}) };
  return timedUsage ? { usage: timedUsage, ...(timedBaseline ? { baseline: timedBaseline } : {}) } : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validUsage(usage: Record<string, unknown>): boolean {
  const input = usage['input_tokens'] ?? usage['inputTokens'];
  const output = usage['output_tokens'] ?? usage['outputTokens'];
  return [input, output].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
}
