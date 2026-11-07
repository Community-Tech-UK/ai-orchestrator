import { describe, expect, it } from 'vitest';
import { CacheAnalyticsService } from './cache-analytics-service';
describe('priced cache rewrites', () => {
  it('prices main-thread calls only and separates expected rewrites after compaction', () => {
    const service = new CacheAnalyticsService();
    const call = { uncachedInput: 0, cacheRead: 100000, cacheWrite: 0, model: 'sonnet', provider: 'claude', ttlMs: 3600000, mainThread: true };
    service.recordCall('i', { ...call, at: 1000 });
    service.recordCall('i', { ...call, uncachedInput: 100000, cacheRead: 0, at: 3602000 });
    expect(service.getReport('i')).toMatchObject({ rewriteTokens: 100000, lastBreak: { cause: 'idle 60 min', missedTokens: 100000 } });
    expect(service.getReport('i').rewriteCostUsd).toBeGreaterThan(0);
    service.recordCall('i', { ...call, uncachedInput: 100000, cacheRead: 0, mainThread: false, at: 3603000 });
    expect(service.getReport('i').rewriteTokens).toBe(100000);
    service.resetBaseline('i');
    service.recordCall('i', { ...call, uncachedInput: 0, cacheRead: 0, cacheWrite: 50000, at: 3604000 });
    expect(service.getReport('i')).toMatchObject({ rewriteTokens: 100000, expectedRewriteTokens: 50000,
      lastBreak: { cause: 'after compaction' } });
  });

  it('accounts one provider call once even when its frames re-report the same usage', () => {
    const service = new CacheAnalyticsService();
    const call = { uncachedInput: 0, cacheRead: 100000, cacheWrite: 0, model: 'sonnet', provider: 'claude', ttlMs: 3600000, mainThread: true };
    service.recordCall('i', { ...call, callId: 'call-1', at: 1000 });
    const miss = { ...call, uncachedInput: 100000, cacheRead: 0, callId: 'call-2' };
    service.recordCall('i', { ...miss, at: 2000 });
    service.recordCall('i', { ...miss, at: 2001 });
    service.recordCall('i', { ...miss, at: 2002 });
    expect(service.getReport('i')).toMatchObject({ rewriteTokens: 100000, lastBreak: { missedTokens: 100000 } });
    expect(service.getReport('i').samples).toHaveLength(2);
    service.recordCall('i', { ...miss, callId: 'call-3', at: 3000 });
    expect(service.getReport('i').rewriteTokens).toBe(200000);
  });

  it('keeps per-call accounting without an identity and forgets very old ids', () => {
    const service = new CacheAnalyticsService();
    const call = { uncachedInput: 0, cacheRead: 100000, cacheWrite: 0, model: 'sonnet', provider: 'claude', ttlMs: 3600000, mainThread: true };
    service.recordCall('i', { ...call, at: 1000 });
    const miss = { ...call, uncachedInput: 100000, cacheRead: 0 };
    service.recordCall('i', { ...miss, at: 2000 });
    service.recordCall('i', { ...miss, at: 2001 });
    expect(service.getReport('i').rewriteTokens).toBe(200000);
    // The id memory is bounded (FIFO): the oldest is forgotten first, so a
    // repeated id beyond the window is accounted again rather than leaking.
    for (let i = 0; i < 65; i++) service.recordCall('i', { ...call, callId: `filler-${i}`, at: 3000 + i });
    service.recordCall('i', { ...miss, callId: 'filler-0', at: 4000 });
    expect(service.getReport('i').rewriteTokens).toBe(300000);
  });
});
