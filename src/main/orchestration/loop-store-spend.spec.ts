import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { LoopState } from '../../shared/types/loop.types';
import { spendProvenanceOf, type LoopSpendPortion } from '../../shared/types/loop-spend.types';
import { LoopSpendByPurposeSchema } from '@contracts/schemas/loop-spend';
import { runLoopMigrations } from './loop-schema';
import { foldPingPongSpend } from './loop-spend-ledger';
import { insertLoopSpend, listLoopSpend, loadScorecardInputs, summarizePersistedLoopSpend } from './loop-store-spend';
import { buildLoopScorecard, scorecardLines } from './loop-scorecard';

describe('persisted reviewer provenance', () => {
  let db: SqliteDriver;
  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    runLoopMigrations(db);
    db.prepare("INSERT INTO loop_runs (id, chat_id, config_json, status, started_at) VALUES ('run', 'chat', '{}', 'completed', 1)").run();
  });
  afterEach(() => db.close());

  it('reconstructs exact cents and zero-cent computed/unknown calls through the real store', () => {
    const portions: LoopSpendPortion[] = [
      { tokens: 10, costCents: 11, basis: 'provider-reported' },
      { tokens: 1, costCents: 0, basis: 'computed' },
      { tokens: 10, costCents: 0, basis: 'unknown' },
      { tokens: 20, costCents: 0, basis: 'unknown' },
    ];
    const state = { id: 'run', totalTokens: 0, totalCostCents: 0 } as LoopState;
    foldPingPongSpend(state, 2, 41, 11, 'unknown', 11, 4, row => insertLoopSpend(db, row), portions);
    expect(listLoopSpend(db, 'run')).toHaveLength(4);
    const summary = summarizePersistedLoopSpend(db, 'run');
    expect(summary).toEqual(state.spendByPurpose);
    expect(LoopSpendByPurposeSchema.parse(summary)).toEqual(summary);
    expect(summary?.review).toMatchObject({ tokens: 41, costCents: 11, knownCents: 11, calls: 4, estimatedCalls: 1, unknownCalls: 2 });
    expect(spendProvenanceOf(summary).label).toBe('partly-estimated');
    const inputs = loadScorecardInputs(db, 'run');
    expect(inputs).not.toBeNull();
    const card = buildLoopScorecard(inputs!);
    expect(card).toMatchObject({ knownCents: 11, costCents: 11, tokens: 41, unknownCalls: 2 });
    const lines = scorecardLines(card).join('\n');
    expect(lines).toContain('2 model call(s) had no usable cost report; the dollar total is incomplete');
    expect(lines).toContain('1 recorded call(s) use estimated costs');
    expect(lines).not.toContain('other recorded costs are calculated from token counts');
  });

  it('keeps unknown-only zero costs unknown after reloading while free reports remain none', () => {
    const state = { id: 'run', totalTokens: 0, totalCostCents: 0 } as LoopState;
    foldPingPongSpend(state, 2, 10, 0, 'unknown', 0, 1, row => insertLoopSpend(db, row), [{ tokens: 10, costCents: 0, basis: 'unknown' }]);
    expect(spendProvenanceOf(summarizePersistedLoopSpend(db, 'run')).label).toBe('unknown');
    expect(spendProvenanceOf({ review: { tokens: 10, costCents: 0, knownCents: 0, calls: 1, estimatedCalls: 0, unknownCalls: 0 } }).label).toBe('none');
  });
});
