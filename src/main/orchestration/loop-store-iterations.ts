import type { SqliteDriver } from '../db/sqlite-driver';
import type { LoopIteration } from '../../shared/types/loop.types';

const DEFAULT_LOOP_ITERATION_LIMIT = 500;
const MAX_LOOP_ITERATION_LIMIT = 5_000;

interface LoopIterationRow {
  id: string;
  loop_run_id: string;
  seq: number;
  stage: string;
  started_at: number;
  ended_at: number | null;
  child_instance_id: string | null;
  tokens: number;
  cost_cents: number;
  files_changed_json: string;
  tool_calls_json: string;
  errors_json: string;
  test_pass_count: number | null;
  test_fail_count: number | null;
  work_hash: string;
  output_similarity_to_prev: number | null;
  output_excerpt: string;
  output_full: string;
  progress_verdict: string;
  progress_signals_json: string;
  completion_signals_fired_json: string;
  verify_status: string;
  verify_output_excerpt: string;
  verify_failure_kind: string | null;
  final_audit_json: string | null;
}

function boundLoopIterationLimit(limit: number | undefined): number {
  return Math.max(
    1,
    Math.min(Math.floor(limit ?? DEFAULT_LOOP_ITERATION_LIMIT), MAX_LOOP_ITERATION_LIMIT),
  );
}

function rowToLoopIteration(row: LoopIterationRow): LoopIteration {
  const iteration: LoopIteration = {
    id: row.id,
    loopRunId: row.loop_run_id,
    seq: row.seq,
    stage: row.stage as LoopIteration['stage'],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    childInstanceId: row.child_instance_id,
    tokens: row.tokens,
    costCents: row.cost_cents,
    filesChanged: JSON.parse(row.files_changed_json),
    toolCalls: JSON.parse(row.tool_calls_json),
    errors: JSON.parse(row.errors_json),
    testPassCount: row.test_pass_count,
    testFailCount: row.test_fail_count,
    workHash: row.work_hash,
    outputSimilarityToPrev: row.output_similarity_to_prev,
    outputExcerpt: row.output_excerpt,
    outputFull: row.output_full ?? '',
    progressVerdict: row.progress_verdict as LoopIteration['progressVerdict'],
    progressSignals: JSON.parse(row.progress_signals_json),
    completionSignalsFired: JSON.parse(row.completion_signals_fired_json),
    verifyStatus: row.verify_status as LoopIteration['verifyStatus'],
    verifyOutputExcerpt: row.verify_output_excerpt,
  };
  if (row.verify_failure_kind) {
    iteration.verifyFailureKind = row.verify_failure_kind as NonNullable<LoopIteration['verifyFailureKind']>;
  }
  if (row.final_audit_json) {
    iteration.finalAudit = JSON.parse(row.final_audit_json) as NonNullable<LoopIteration['finalAudit']>;
  }
  return iteration;
}

export function selectLoopIterations(
  db: SqliteDriver,
  loopRunId: string,
  fromSeq?: number,
  toSeq?: number,
  options: { limit?: number; offset?: number } = {},
): LoopIteration[] {
  let sql = 'SELECT * FROM loop_iterations WHERE loop_run_id = ?';
  const args: unknown[] = [loopRunId];
  if (fromSeq != null) {
    sql += ' AND seq >= ?';
    args.push(fromSeq);
  }
  if (toSeq != null) {
    sql += ' AND seq <= ?';
    args.push(toSeq);
  }
  sql += ' ORDER BY seq ASC LIMIT ? OFFSET ?';
  args.push(boundLoopIterationLimit(options.limit), Math.max(0, Math.floor(options.offset ?? 0)));
  const rows = db.prepare(sql).all<LoopIterationRow>(...args);
  return rows.map(rowToLoopIteration);
}

export function countLoopIterations(db: SqliteDriver, loopRunId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM loop_iterations WHERE loop_run_id = ?')
    .get<{ count: number }>(loopRunId);
  return row?.count ?? 0;
}
