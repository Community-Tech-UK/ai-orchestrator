import type { SqliteDriver } from '../db/sqlite-driver';
import type { LoopSpendRow } from '../../shared/types/loop-spend.types';
import { buildLoopScorecard } from './loop-scorecard';
export function insertLoopSpend(db: SqliteDriver, row: LoopSpendRow): void {
  db.prepare(`INSERT INTO loop_run_spend (id, loop_run_id, iteration_seq, purpose, detail, provider, model, tokens, cache_read_tokens, cache_write_tokens, cost_cents, basis, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.loopRunId, row.iterationSeq ?? null, row.purpose, row.detail ?? null, row.provider ?? null, row.model ?? null, row.tokens, row.cacheReadTokens ?? null, row.cacheWriteTokens ?? null, row.costCents, row.basis, row.createdAt);
}
export function listLoopSpend(db: SqliteDriver, loopRunId: string): LoopSpendRow[] {
  return db.prepare(`SELECT id, loop_run_id AS loopRunId, iteration_seq AS iterationSeq, purpose, detail, provider, model, tokens, cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens, cost_cents AS costCents, basis, created_at AS createdAt FROM loop_run_spend WHERE loop_run_id = ? ORDER BY created_at, id`).all<LoopSpendRow>(loopRunId);
}

export function loadScorecardInputs(db: SqliteDriver, loopRunId: string): import('./loop-scorecard').ScorecardInputs | null {
  const run = db.prepare('SELECT total_cost_cents AS totalCostCents, total_tokens AS totalTokens FROM loop_runs WHERE id = ?').get<{ totalCostCents: number; totalTokens: number }>(loopRunId);
  if (!run) return null;
  const rows = db.prepare(`SELECT seq, tokens, cost_cents, cost_known, finish_reason, prompt_bytes, completion_signals_fired_json FROM loop_iterations WHERE loop_run_id = ? ORDER BY seq`).all<{seq:number;tokens:number;cost_cents:number;cost_known:number|null;finish_reason:string|null;prompt_bytes:number|null;completion_signals_fired_json:string}>(loopRunId);
  const checkpoint = db.prepare('SELECT state_json FROM loop_checkpoints WHERE loop_run_id = ?').get<{state_json:string}>(loopRunId);
  let ledger: import('./loop-scorecard').ScorecardInputs['ledger'];
  try { ledger = checkpoint ? (JSON.parse(checkpoint.state_json) as {ledgerConvergence?: typeof ledger}).ledgerConvergence : undefined; } catch { /* Corrupt checkpoint leaves the task metric unrecorded. */ }
  return {run, iterations: rows.map(row => ({seq:row.seq,tokens:row.tokens,costCents:row.cost_cents,costKnown:row.cost_known === null ? undefined : row.cost_known === 1,finishReason:row.finish_reason ?? undefined,promptBytes:row.prompt_bytes ?? undefined,completionSignalsFired:JSON.parse(row.completion_signals_fired_json)})),spendRows:listLoopSpend(db,loopRunId),ledger};
}

export function summarizePersistedLoopSpend(db: SqliteDriver, loopRunId: string): import('../../shared/types/loop-spend.types').LoopSpendByPurpose | undefined {
  const inputs = loadScorecardInputs(db, loopRunId);
  if (!inputs || (!inputs.iterations.length && !inputs.spendRows.length)) return undefined;
  return buildLoopScorecard(inputs).byPurpose;
}
