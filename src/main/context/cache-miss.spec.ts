import { describe, expect, it } from 'vitest';
import { assessCacheMiss } from './cache-miss';
describe('cache miss assessment', () => {
  const prior = { promptTokens: 100000, at: 0, model: 'sonnet' };
  it('counts idle beyond the TTL and respects Copilot reported lifetimes', () => {
    expect(assessCacheMiss(prior, { promptTokens: 100000, cacheRead: 0, cacheWrite: 100000, at: 301000, model: 'sonnet' }, [], 300000))
      .toMatchObject({ missedTokens: 100000, cause: 'idle 5 min', idleMs: 301000 });
  });
  it('labels unexplained misses and gives compaction priority over every other cause', () => {
    const current = { promptTokens: 100000, cacheRead: 0, cacheWrite: 100000, at: 100, model: 'opus' };
    expect(assessCacheMiss(prior, { ...current, model: 'sonnet' }, [], 3600000)?.cause).toBe('provider-side, nothing to fix');
    expect(assessCacheMiss(prior, current, ['after compaction', 'settings change: tools'], 3600000)?.cause).toBe('after compaction');
    expect(assessCacheMiss(prior, current, [], 3600000)?.cause).toBe('model switch');
  });
  it('ignores 1024 tokens and a three-percent drop', () => {
    expect(assessCacheMiss(prior, { promptTokens: 100000, cacheRead: 99000, at: 100 }, [], 3600000)).toBeNull();
    expect(assessCacheMiss(prior, { promptTokens: 100000, cacheRead: 97000, at: 100 }, [], 3600000)).toBeNull();
  });
});
