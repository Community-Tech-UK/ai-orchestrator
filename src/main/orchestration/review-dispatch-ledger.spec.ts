import { mkdtempSync, rmSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCostAttributionForTesting } from '../core/system/cost-attribution';
import { _resetReviewDispatchLedgerForTesting, getReviewDailyUsage, reserveReviewDispatch } from './review-dispatch-ledger';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'review-ledger-'));
  vi.stubEnv('AIO_COST_ATTRIBUTION', '1');
  vi.stubEnv('AIO_COST_ATTRIBUTION_DIR', dir);
  _resetCostAttributionForTesting();
  _resetReviewDispatchLedgerForTesting();
});
afterEach(() => { vi.unstubAllEnvs(); _resetCostAttributionForTesting(); rmSync(dir, { recursive: true, force: true }); });
function reserve(trigger: 'automatic' | 'manual' = 'automatic', now = new Date()) {
  return reserveReviewDispatch({ limit: 20, reviewId: 'review', instanceId: 'session', trigger, now });
}
describe('durable second-opinion daily reservations', () => {
  it('refuses the 21st automatic review, survives a restart, and counts manual reviews over the cap', () => {
    for (let i = 0; i < 20; i++) expect(reserve().allowed).toBe(true);
    _resetReviewDispatchLedgerForTesting();
    expect(reserve()).toMatchObject({ allowed: false, used: 20, limit: 20 });
    expect(reserve('manual')).toMatchObject({ allowed: true, used: 21 });
    expect(getReviewDailyUsage(20)).toMatchObject({ used: 21, limitReached: true });
  });
  it('counts only dispatch markers within local midnight boundaries across UTC files', () => {
    const now = new Date(2026, 9, 11, 12);
    const start = new Date(2026, 9, 11).getTime();
    for (const ts of [start - 1, start, now.getTime(), new Date(2026, 9, 12).getTime()]) {
      appendFileSync(join(dir, `cost-attribution-${new Date(ts).toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ ts, reviewDispatch: true }) + '\n');
    }
    appendFileSync(join(dir, `cost-attribution-${now.toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ ts: now.getTime(), purpose: 'cross-model-review' }) + '\npartial');
    expect(getReviewDailyUsage(20, now)).toMatchObject({ used: 2, resetsAt: new Date(2026, 9, 12).getTime() });
  });
  it('uses an in-memory counter when logging is opted out and resets at local midnight', () => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    const now = new Date(2026, 9, 11, 23);
    for (let i = 0; i < 20; i++) reserve('automatic', now);
    expect(reserve('automatic', now)).toMatchObject({ allowed: false, used: 20 });
    expect(getReviewDailyUsage(20, new Date(2026, 9, 12, 1)).used).toBe(0);
  });
  it('a zero limit disables automatic dispatch but allows a counted manual request', () => {
    const input = { limit: 0, reviewId: 'r', instanceId: 's' };
    expect(reserveReviewDispatch({ ...input, trigger: 'automatic' }).allowed).toBe(false);
    expect(reserveReviewDispatch({ ...input, trigger: 'manual' })).toMatchObject({ allowed: true, used: 1 });
  });
});
