import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAccountContinuation } from './account-continuation-policy';

const pool = vi.hoisted(() => ({
  continuation: 'shared-store' as 'shared-store' | 'replay',
  reads: 0,
  fail: false,
}));
vi.mock('../../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({
    getPoolPolicy: (provider: string) => {
      pool.reads++;
      if (pool.fail) throw new Error('store unavailable');
      void provider;
      return { continuation: pool.continuation };
    },
  }),
}));

beforeEach(() => {
  pool.continuation = 'shared-store';
  pool.reads = 0;
  pool.fail = false;
});

afterEach(() => vi.clearAllMocks());

describe('readAccountContinuation', () => {
  it('follows the pool policy a handoff is executed under', () => {
    pool.continuation = 'replay';
    expect(readAccountContinuation('claude')).toBe('replay');
    pool.continuation = 'shared-store';
    expect(readAccountContinuation('codex')).toBe('shared-store');
    expect(pool.reads).toBe(2);
  });

  it('replays outside a pool, and when the store cannot answer', () => {
    expect(readAccountContinuation('gemini')).toBe('replay');
    pool.fail = true;
    expect(readAccountContinuation('claude')).toBe('replay');
    expect(pool.reads).toBe(1); // the non-pool provider never touched the store
  });
});
