import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  LoopConfig,
  LoopWorktreeLifecycle,
} from '../../shared/types/loop.types';

export interface PendingLoopWorktreeLifecycle {
  id: string;
  status: string;
  workspaceCwd: string;
  worktreePath: string | null;
  branchName: string | null;
  autoIntegrateWorktree: boolean;
  lifecycle: LoopWorktreeLifecycle;
}

export function parseWorktreeLifecycle(
  value: string | null,
): LoopWorktreeLifecycle | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as LoopWorktreeLifecycle;
  } catch {
    return undefined;
  }
}

export function updateLoopWorktreeLifecycle(
  db: SqliteDriver,
  loopRunId: string,
  lifecycle: LoopWorktreeLifecycle,
): void {
  db.prepare(
    'UPDATE loop_runs SET worktree_lifecycle_json = ? WHERE id = ?',
  ).run(JSON.stringify(lifecycle), loopRunId);
}

export function reserveManagedLoopWorktree(
  db: SqliteDriver,
  input: {
    id: string;
    chatId: string;
    config: LoopConfig;
    lifecycle: LoopWorktreeLifecycle;
  },
): void {
  if (
    input.lifecycle.managedByAio !== true
    || !input.lifecycle.sessionTip
  ) {
    throw new Error('Managed worktree reservation requires durable ownership and ref identity');
  }
  const now = Date.now();
  db.prepare(`
    INSERT INTO loop_runs (
      id, chat_id, plan_file, config_json, status, started_at, ended_at,
      total_iterations, total_tokens, total_cost_cents, current_stage,
      completed_file_rename_observed, highest_test_pass_count, end_reason,
      end_evidence_json, manual_review_only, worktree_path, branch_name,
      worktree_lifecycle_json
    ) VALUES (?, ?, ?, ?, 'error', ?, ?, 0, 0, 0, NULL, 0, 0, ?, NULL, 0, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    input.id,
    input.chatId,
    input.config.planFile ?? null,
    JSON.stringify(input.config),
    now,
    now,
    'worktree-startup-interrupted',
    input.config.executionCwd ?? null,
    input.config.worktreeBranch ?? null,
    JSON.stringify(input.lifecycle),
  );
}

export function getPendingLoopWorktreeLifecycles(
  db: SqliteDriver,
): PendingLoopWorktreeLifecycle[] {
  interface Row {
    id: string;
    status: string;
    config_json: string;
    worktree_path: string | null;
    branch_name: string | null;
    worktree_lifecycle_json: string;
    ended_at: number | null;
  }
  const rows = db.prepare(`
    SELECT id, status, config_json, worktree_path, branch_name,
           worktree_lifecycle_json, ended_at
    FROM loop_runs
    WHERE worktree_lifecycle_json IS NOT NULL
      AND status NOT IN ('running', 'paused')
      AND (status <> 'provider-limit' OR ended_at IS NOT NULL)
  `).all<Row>();
  return rows.flatMap((row) => {
    const lifecycle = parseWorktreeLifecycle(row.worktree_lifecycle_json);
    if (!lifecycle || lifecycle.phase === 'cleaned') return [];
    try {
      const config = JSON.parse(row.config_json) as {
        workspaceCwd?: string;
        autoIntegrateWorktree?: boolean;
      };
      if (typeof config.workspaceCwd !== 'string') return [];
      return [{
        id: row.id,
        status: row.status,
        workspaceCwd: config.workspaceCwd,
        worktreePath: row.worktree_path,
        branchName: row.branch_name,
        autoIntegrateWorktree: config.autoIntegrateWorktree !== false,
        lifecycle,
      }];
    } catch {
      return [];
    }
  });
}
