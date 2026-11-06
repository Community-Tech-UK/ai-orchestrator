import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import { collectUsageLimitHandling } from '../cli/usage-limit-dispatch';
import type { UsageLimitHandling } from '../cli/usage-limit-notice';
import { USAGE_LIMIT_WINDOW_KEY, usageLimitWindow } from '../cli/usage-limit-window';
import { announceUsageLimit, type UsageLimitAnnouncement } from './instance-usage-limit-announcement';

vi.mock('../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({ getProfile: (_provider: string, id: string) => (id === 'work-1' ? { label: 'Work' } : null) }),
}));

const NOON = new Date(2026, 9, 20, 12);
const FIVE_PM = new Date(2026, 9, 20, 17).getTime();
const parked: UsageLimitHandling = { kind: 'parked', autoResume: true, heldMessage: false, metadata: { providerLimitParked: true } };

const announcement = (overrides: Partial<UsageLimitAnnouncement> = {}): UsageLimitAnnouncement => ({
  instanceId: 'session-1', provider: 'claude', accountProfileId: 'work-1', resetAt: FIVE_PM,
  reason: 'provider limit on turn: stream closed', handling: parked, ...overrides,
});
const earlier = (tag: Parameters<typeof usageLimitWindow>[0]): OutputMessage => ({
  id: 'earlier', timestamp: tag.now, type: 'system', content: 'An earlier note.', metadata: { [USAGE_LIMIT_WINDOW_KEY]: usageLimitWindow(tag) },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('announceUsageLimit', () => {
  it('writes the one note, naming the account, with what Harness did, the presentation and its window beside it', () => {
    const emit = vi.fn();
    announceUsageLimit(emit, announcement());

    expect(emit).toHaveBeenCalledTimes(1);
    const [instanceId, content, metadata] = emit.mock.calls[0];
    expect(instanceId).toBe('session-1');
    expect(content).toBe(
      'Your Work Claude account has used its current allowance. It resets at 17:00. '
      + 'What to do: Wait for the allowance to reset, or switch account. '
      + 'Harness will pick this session up again once the allowance resets.',
    );
    expect(metadata).toMatchObject({
      providerLimitParked: true,
      errorPresentation: { category: 'quota', rawDetail: 'provider limit on turn: stream closed' },
      usageLimitWindow: { provider: 'claude', account: 'work-1', resetAt: FIVE_PM, announcedAt: NOON.getTime() },
    });
  });

  it('hands what was done to the writer that is already announcing this event, and writes nothing itself', () => {
    const emit = vi.fn();
    const collected = collectUsageLimitHandling('claude', () => announceUsageLimit(emit, announcement()));

    expect(emit).not.toHaveBeenCalled();
    expect(collected.handling).toBe(parked);
  });

  it('only reports, and never writes, when it has nowhere to write', () => {
    const collected = collectUsageLimitHandling('claude', () => announceUsageLimit(undefined, announcement()));
    expect(collected.handling).toBe(parked);
    expect(() => announceUsageLimit(undefined, announcement())).not.toThrow();
  });

  describe('with the conversation so far', () => {
    it('says nothing when it already holds the note for this window', () => {
      const emit = vi.fn();
      announceUsageLimit(emit, announcement({
        transcript: [earlier({ provider: 'claude', accountProfileId: 'work-1', resetAt: FIVE_PM, now: NOON.getTime() - 10 * 60_000 })],
      }));
      expect(emit).not.toHaveBeenCalled();
    });

    it.each([
      ['another account', { provider: 'claude', accountProfileId: 'home-2', resetAt: FIVE_PM, now: NOON.getTime() - 10 * 60_000 }],
      ['another provider', { provider: 'codex', accountProfileId: 'work-1', resetAt: FIVE_PM, now: NOON.getTime() - 10 * 60_000 }],
      ['a window that has ended', { provider: 'claude', accountProfileId: 'work-1', resetAt: NOON.getTime() - 3_600_000, now: NOON.getTime() - 10_800_000 }],
    ])('writes the note when the one it holds is for %s', (_label, tag) => {
      const emit = vi.fn();
      announceUsageLimit(emit, announcement({ transcript: [earlier(tag)] }));
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('writes the note into an empty conversation', () => {
      const emit = vi.fn();
      announceUsageLimit(emit, announcement({ transcript: [] }));
      expect(emit).toHaveBeenCalledTimes(1);
    });
  });

  it('leaves the account out for the default account, and for a store it cannot read', () => {
    const emit = vi.fn();
    announceUsageLimit(emit, announcement({ accountProfileId: 'legacy' }));
    announceUsageLimit(emit, announcement({ accountProfileId: 'unknown-9' }));
    expect(emit.mock.calls[0][1]).toContain('Your Claude account has used');
    expect(emit.mock.calls[1][1]).toContain('Your Claude account has used');
  });
});
