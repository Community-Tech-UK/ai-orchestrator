import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ClaudeCostReconcileReport } from '../../../shared/types/claude-cost-reconcile.types';
import { ClaudeCostReconcileStore, EMPTY_RECONCILE_STATE, RECONCILE_HISTORY_LIMIT, type ClaudeCostReconcileState } from './claude-cost-reconcile-store';

const group = (sessions: number, storedUsd: number, cliUsd: number) => ({ sessions, storedUsd, cliUsd, gapUsd: storedUsd - cliUsd, driftPct: cliUsd > 0 ? ((storedUsd - cliUsd) / cliUsd) * 100 : null });
const report = (checkedAt: number): ClaudeCostReconcileReport => ({
  version: 1, checkedAt, windowStart: 0, thresholdPct: 5, status: 'ok', total: group(1, 10, 10),
  byEra: { 'per-turn': group(1, 10, 10), repaired: group(0, 0, 0) },
  coverage: { candidates: 1, notClaude: 0, noTranscript: 0, unsettled: 0, unknownModelCost: 0, compared: 1 }, largestGaps: [],
});
const state = (over: Partial<ClaudeCostReconcileState> = {}): ClaudeCostReconcileState =>
  ({ latest: report(100), history: [{ checkedAt: 100, status: 'ok', total: group(1, 10, 10) }], lastAttemptAt: 100, lastError: null, ...over });

describe('ClaudeCostReconcileStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aio-reconcile-store-')); file = join(dir, 'nested', 'state.json'); });
  afterEach(() => { try { chmodSync(join(dir, 'nested'), 0o700); } catch { /* not created */ } rmSync(dir, { recursive: true, force: true }); });

  it('round-trips a state, creating the folder, and leaves no temporary file behind', () => {
    const store = new ClaudeCostReconcileStore(file);
    store.save(state());
    expect(store.load()).toEqual(state());
    expect(readdirSync(join(dir, 'nested'))).toEqual(['state.json']);
  });

  it('reads a missing, empty, damaged or wrongly shaped file as "no history yet"', () => {
    const store = new ClaudeCostReconcileStore(file);
    expect(store.load()).toEqual(EMPTY_RECONCILE_STATE);
    mkdirSync(join(dir, 'nested'));
    for (const text of ['', '{not json', '[]', '7', 'null']) {
      writeFileSync(file, text);
      expect(store.load(), text).toEqual(EMPTY_RECONCILE_STATE);
    }
  });

  it('drops a latest report with the wrong shape and any history entry that is not a summary, keeping what is valid', () => {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(file, JSON.stringify({
      latest: { version: 2, checkedAt: 1 },
      history: [{ checkedAt: 5, status: 'ok', total: group(1, 1, 1) }, { checkedAt: 'x' }, null, 7, { checkedAt: 6, status: 'drift', total: null }],
      lastAttemptAt: 'yesterday', lastError: 12,
    }));
    expect(new ClaudeCostReconcileStore(file).load()).toEqual({ latest: null, history: [{ checkedAt: 5, status: 'ok', total: group(1, 1, 1) }], lastAttemptAt: null, lastError: null });
  });

  it('keeps only the newest entries of a long history, on save and on load', () => {
    const history = Array.from({ length: RECONCILE_HISTORY_LIMIT + 10 }, (_, index) => ({ checkedAt: 1000 - index, status: 'ok' as const, total: group(1, 1, 1) }));
    const store = new ClaudeCostReconcileStore(file);
    store.save(state({ history }));
    expect(JSON.parse(readFileSync(file, 'utf8')).history).toHaveLength(RECONCILE_HISTORY_LIMIT);
    expect(store.load().history[0].checkedAt).toBe(1000);
    writeFileSync(file, JSON.stringify({ ...state(), history }));
    expect(store.load().history).toHaveLength(RECONCILE_HISTORY_LIMIT);
  });

  it('does not throw when the file cannot be written, and keeps the previous file intact', () => {
    const store = new ClaudeCostReconcileStore(file);
    store.save(state());
    chmodSync(join(dir, 'nested'), 0o500);
    expect(() => store.save(state({ lastError: 'later' }))).not.toThrow();
    chmodSync(join(dir, 'nested'), 0o700);
    expect(store.load().lastError).toBeNull();
  });
});
