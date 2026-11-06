import { describe, expect, it } from 'vitest';
import type { ContextUsage } from '../types/instance.types';
import {
  CACHE_LIFETIME_FALLBACK_MS,
  IDLE_HINT_AFTER_MS,
  decideIdleHint,
  decideSleepContext,
  formatApproxTokens,
  idleHintText,
  resolveCacheLifetimeMs,
  trustedContextTokens,
} from './claude-cache-economics';

const MIN = 60_000;

describe('resolveCacheLifetimeMs', () => {
  it('uses the measured lifetime when it is sensible', () => {
    expect(resolveCacheLifetimeMs(5 * MIN)).toBe(5 * MIN);
    expect(resolveCacheLifetimeMs(60 * MIN)).toBe(60 * MIN);
  });

  it('falls back to one hour for missing or nonsense readings', () => {
    for (const bad of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 25 * 60 * MIN]) {
      expect(resolveCacheLifetimeMs(bad)).toBe(CACHE_LIFETIME_FALLBACK_MS);
    }
  });
});

describe('trustedContextTokens', () => {
  const reported: ContextUsage = { used: 230_000, total: 1_000_000, percentage: 23, occupancyReported: true };

  it('trusts a reported window reading', () => {
    expect(trustedContextTokens(reported)).toBe(230_000);
  });

  it('does not trust placeholders or running spend totals', () => {
    expect(trustedContextTokens(undefined)).toBeNull();
    expect(trustedContextTokens({ ...reported, occupancyReported: false })).toBeNull();
    expect(trustedContextTokens({ ...reported, occupancyIsAggregate: true })).toBeNull();
    expect(trustedContextTokens({ ...reported, used: 0 })).toBeNull();
  });
});

describe('decideSleepContext', () => {
  const base = { sleepMs: 3 * 60 * MIN, contextTokens: 250_000, canCompact: true, canRecycle: true };

  it('compacts a large session that will sleep past its cache lifetime', () => {
    expect(decideSleepContext(base)).toMatchObject({ action: 'compact', cacheLifetimeMs: CACHE_LIFETIME_FALLBACK_MS });
  });

  it('recycles when compaction cannot run (for example the account is out of allowance)', () => {
    expect(decideSleepContext({ ...base, canCompact: false })).toMatchObject({ action: 'recycle' });
  });

  it('does nothing when neither is possible', () => {
    expect(decideSleepContext({ ...base, canCompact: false, canRecycle: false })).toMatchObject({ action: 'none' });
  });

  it('uses the measured lifetime, not a fixed hour', () => {
    // A 30 minute sleep outlives a 5 minute cache but not a 1 hour one.
    const thirty = { ...base, sleepMs: 30 * MIN };
    expect(decideSleepContext({ ...thirty, cacheLifetimeMs: 5 * MIN })).toMatchObject({ action: 'compact', cacheLifetimeMs: 5 * MIN });
    expect(decideSleepContext({ ...thirty, cacheLifetimeMs: 60 * MIN })).toMatchObject({ action: 'none' });
    expect(decideSleepContext(thirty)).toMatchObject({ action: 'none' });
  });

  it('keeps the 200K floor exact', () => {
    expect(decideSleepContext({ ...base, contextTokens: 199_999 })).toMatchObject({ action: 'none' });
    expect(decideSleepContext({ ...base, contextTokens: 200_000 })).toMatchObject({ action: 'compact' });
  });

  it('never acts on an unknown wake-up time or an unknown size', () => {
    expect(decideSleepContext({ ...base, sleepMs: null })).toMatchObject({ action: 'none' });
    expect(decideSleepContext({ ...base, sleepMs: Number.NaN })).toMatchObject({ action: 'none' });
    expect(decideSleepContext({ ...base, contextTokens: null })).toMatchObject({ action: 'none' });
  });

  it('treats a sleep exactly equal to the lifetime as still warm', () => {
    expect(decideSleepContext({ ...base, sleepMs: CACHE_LIFETIME_FALLBACK_MS })).toMatchObject({ action: 'none' });
  });
});

describe('decideIdleHint', () => {
  const base = {
    provider: 'claude',
    status: 'idle',
    idleMs: 80 * MIN,
    contextTokens: 230_000,
    wakeUpPending: false,
    backgroundWorkPending: false,
    dialogPending: false,
  };

  it('shows the hint after 75 idle minutes at 100K or more', () => {
    const hint = decideIdleHint(base);
    expect(hint).toEqual({
      show: true,
      tokens: 230_000,
      text: 'Starting something new? A fresh session would skip re-reading about 230K tokens.',
    });
  });

  it('also shows for a session that was hibernated while the person was away', () => {
    expect(decideIdleHint({ ...base, status: 'hibernated' })).toMatchObject({ show: true });
  });

  it('waits for exactly 75 minutes and 100K', () => {
    expect(decideIdleHint({ ...base, idleMs: IDLE_HINT_AFTER_MS - 1 })).toMatchObject({ show: false });
    expect(decideIdleHint({ ...base, idleMs: IDLE_HINT_AFTER_MS })).toMatchObject({ show: true });
    expect(decideIdleHint({ ...base, contextTokens: 99_999 })).toMatchObject({ show: false });
    expect(decideIdleHint({ ...base, contextTokens: 100_000 })).toMatchObject({ show: true });
  });

  it.each([
    ['a wake-up is pending', { wakeUpPending: true }],
    ['background agents are running', { backgroundWorkPending: true }],
    ['a dialog is open', { dialogPending: true }],
  ])('stays quiet while %s', (_name, patch) => {
    expect(decideIdleHint({ ...base, ...patch })).toMatchObject({ show: false });
  });

  it('stays quiet for other providers, busy sessions and unknown sizes', () => {
    expect(decideIdleHint({ ...base, provider: 'codex' })).toMatchObject({ show: false });
    expect(decideIdleHint({ ...base, status: 'busy' })).toMatchObject({ show: false });
    expect(decideIdleHint({ ...base, status: 'waiting_for_input' })).toMatchObject({ show: false });
    expect(decideIdleHint({ ...base, contextTokens: null })).toMatchObject({ show: false });
  });

  it('does not claim a re-read is saved while a long measured cache would still be warm', () => {
    const twoHours = 120 * MIN;
    expect(decideIdleHint({ ...base, cacheLifetimeMs: twoHours, idleMs: 100 * MIN })).toMatchObject({ show: false });
    expect(decideIdleHint({ ...base, cacheLifetimeMs: twoHours, idleMs: 121 * MIN })).toMatchObject({ show: true });
  });
});

describe('token wording', () => {
  it.each([
    [107_300, '110K'],
    [230_512, '230K'],
    [99_400, '99K'],
    [1_000_000, '1M'],
    [1_234_567, '1.2M'],
  ])('formats %i as %s', (tokens, expected) => {
    expect(formatApproxTokens(tokens)).toBe(expected);
  });

  it('puts the size in the sentence', () => {
    expect(idleHintText(1_234_567)).toBe('Starting something new? A fresh session would skip re-reading about 1.2M tokens.');
  });
});
