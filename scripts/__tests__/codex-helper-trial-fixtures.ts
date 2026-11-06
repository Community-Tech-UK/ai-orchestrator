/**
 * Real-shape fixtures for the Codex helper trial report specs.
 *
 * Every shape here was read from this Mac's live files (20 Oct 2026, shapes and
 * counts only, never content):
 *  - `plan_queue_items` is the live table's DDL, column for column;
 *  - a cost-attribution row is the live `instance-turn` line (`ts`, `source`,
 *    `taskType`, `instanceId`, `parentId`, `agentId`, `provider`, `model`,
 *    `usage`, `costKnown`, `isEstimated`, and `purpose` on some rows);
 *  - a session-policy record is the writer's `CodexSessionPolicyRecord`.
 * Codex's `usage.inputTokens` is UNCACHED input (token-usage-breakdown.ts
 * subtracts the cached part), so gross input is `inputTokens + cacheReadTokens`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PLAN_QUEUE_ITEMS_DDL = `CREATE TABLE plan_queue_items (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES plan_queue_runs(id) ON DELETE CASCADE,
        document_path TEXT NOT NULL,
        state TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 0,
        errored_rounds INTEGER NOT NULL DEFAULT 0,
        branch_name TEXT,
        worktree_path TEXT,
        base_commit TEXT,
        checkpoint_commit TEXT,
        verified_main_commit TEXT,
        landed_commit TEXT,
        worker_instance_id TEXT,
        verifier_instance_id TEXT,
        question_json TEXT,
        answer TEXT,
        park_reason TEXT,
        detail TEXT,
        verdict_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, landing_refusals INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, exact_cost_usd REAL NOT NULL DEFAULT 0, held_at INTEGER, pending_instruction TEXT,
        UNIQUE (run_id, document_path)
      );`;

export interface QueueItemRow {
  id: string;
  state: string;
  round?: number;
  createdAt: number;
  updatedAt: number;
  /** The queue's own ledger; mostly 0 on the live table, so the report must not rely on it. */
  tokens?: number;
}

/** INSERT statements that fill every NOT NULL column the way the live table does. */
export function queueItemInserts(rows: QueueItemRow[]): string {
  return rows.map((row) => `INSERT INTO plan_queue_items
    (id, run_id, document_path, state, round, created_at, updated_at, tokens)
    VALUES ('${row.id}', 'run-1', 'docs/plans/${row.id}.md', '${row.state}', ${row.round ?? 1},
      ${row.createdAt}, ${row.updatedAt}, ${row.tokens ?? 0});`).join('\n');
}

export function writeLoopDb(path: string, rows: QueueItemRow[]): void {
  execFileSync('sqlite3', [path, `${PLAN_QUEUE_ITEMS_DDL}\n${queueItemInserts(rows)}`]);
}

export interface CostRowInput {
  instanceId: string;
  /** Uncached input (Codex rows), cache reads, output. */
  input: number;
  cacheRead: number;
  output?: number;
  ts?: number;
  isEstimated?: boolean;
  provider?: string;
  /** Leave out a usage field to build a malformed row. */
  omit?: 'cacheReadTokens' | 'inputTokens';
}

/** One live-shape `instance-turn` line. */
export function costRow(input: CostRowInput): Record<string, unknown> {
  const usage: Record<string, unknown> = {
    inputTokens: input.input, outputTokens: input.output ?? 5, cacheReadTokens: input.cacheRead,
    cacheWriteTokens: 0, reasoningTokens: 0, cost: 0.01,
  };
  if (input.omit) delete usage[input.omit];
  return {
    ts: input.ts ?? Date.parse('2026-10-01T10:05:00.000Z'),
    source: 'instance-turn', taskType: 'child:build', instanceId: input.instanceId,
    parentId: 'parent-instance', agentId: 'build', provider: input.provider ?? 'codex',
    model: 'gpt-fixture', usage, costKnown: true, isEstimated: input.isEstimated ?? false,
    purpose: 'plan-queue',
  };
}

/** Writes `cost-attribution-YYYY-MM-DD.jsonl` files, grouped by each row's UTC day. */
export function writeCostDir(dir: string, rows: Record<string, unknown>[], extraLines: string[] = []): void {
  mkdirSync(dir, { recursive: true });
  const byDay = new Map<string, string[]>();
  for (const row of rows) {
    const day = new Date(row['ts'] as number).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(row)]);
  }
  for (const [day, lines] of byDay) {
    writeFileSync(join(dir, `cost-attribution-${day}.jsonl`), [...lines, ...extraLines].join('\n') + '\n');
  }
}

/** The follow-up record the Codex adapter writes when it first sees a helper thread. */
export function helperCountRecord(input: {
  at: string; threadId: string; instanceId?: string; helperThreads: number;
}): Record<string, unknown> {
  return { at: input.at, provider: 'codex', recordType: 'helper-count', threadId: input.threadId,
    ...(input.instanceId ? { instanceId: input.instanceId } : {}), helperThreads: input.helperThreads };
}
