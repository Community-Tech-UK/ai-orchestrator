import { describe, expect, it } from 'vitest';
import { COLD_CACHE_IDLE_MS, evaluateColdCacheResume, type ColdCacheResumeFacts } from './cold-cache-resume';

const NOW = 1_700_000_000_000;
const baseline: ColdCacheResumeFacts = {
  provider: 'claude', status: 'idle', usage: { used: 100_000, occupancyReported: true },
  lastAssistantAt: NOW - COLD_CACHE_IDLE_MS, now: NOW, compacting: false, hasQueued: false, quotaParked: false,
};
const evaluate = (change: Partial<ColdCacheResumeFacts> = {}) => evaluateColdCacheResume({ ...baseline, ...change });

describe('cold Claude return', () => {
  it('offers at 100K reported tokens and 70 minutes, but not below either boundary', () => {
    expect(evaluate()).toEqual({ offer: true, tokens: 100_000, idleMinutes: 70 });
    expect(evaluate({ usage: { used: 99_999, occupancyReported: true } })).toEqual({ offer: false });
    expect(evaluate({ lastAssistantAt: NOW - 69 * 60_000 })).toEqual({ offer: false });
    expect(evaluate({ lastAssistantAt: NOW - 60_000 })).toEqual({ offer: false });
  });

  it('requires a Claude idle session with a real occupancy reading and no held work', () => {
    for (const change of [
      { provider: 'codex' }, { status: 'busy' }, { usage: undefined },
      { usage: { used: 150_000, occupancyReported: false } },
      { usage: { used: 150_000, occupancyReported: true, occupancyIsAggregate: true } },
      { lastAssistantAt: undefined }, { compacting: true }, { hasQueued: true }, { quotaParked: true },
    ]) expect(evaluate(change)).toEqual({ offer: false });
  });
});
