import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexThreadCreditsLedger, parseCodexThreadCredits, readCodexThreadCredits } from './codex-credit-reader';

const response = (overrides: Record<string, unknown> = {}) => ({
  summary: { lifetimeTokens: 1 },
  threadUsage: {
    threadId: 'thread-1',
    estimatedUsageCreditsMicros: 12_500_000,
    estimatedUsageUsdMicros: 500_000,
    groups: [
      { model: 'gpt-6-astra', reasoningEffort: 'high', speed: 'standard', inputTokens: 900, cachedInputTokens: 800, netNewInputTokens: 100, outputTokens: 100, totalTokens: 1_000, estimatedUsageCreditsMicros: 10_000_000 },
      { model: null, totalTokens: null, estimatedUsageCreditsMicros: 2_500_000 },
    ],
    ...overrides,
  },
});

describe('Codex thread credits (account/usage/read)', () => {
  it('reads the credit estimate and per-model groups for the thread', () => {
    expect(parseCodexThreadCredits(response(), 'thread-1')).toEqual({
      threadId: 'thread-1',
      estimatedUsageCreditsMicros: 12_500_000,
      estimatedUsageUsdMicros: 500_000,
      totalTokens: 1_000,
      groups: [
        { model: 'gpt-6-astra', reasoningEffort: 'high', speed: 'standard', totalTokens: 1_000, estimatedUsageCreditsMicros: 10_000_000 },
        { model: null, reasoningEffort: null, speed: null, totalTokens: null, estimatedUsageCreditsMicros: 2_500_000 },
      ],
    });
  });

  it('reports no reading when Codex has no billing route for the thread', () => {
    expect(parseCodexThreadCredits({ summary: {}, threadUsage: null }, 'thread-1')).toBeNull();
    expect(parseCodexThreadCredits(undefined, 'thread-1')).toBeNull();
  });

  it('never accepts another thread\'s figures or malformed numbers', () => {
    expect(parseCodexThreadCredits(response({ threadId: 'other' }), 'thread-1')).toBeNull();
    expect(parseCodexThreadCredits(response({ estimatedUsageCreditsMicros: 'lots' }), 'thread-1')).toBeNull();
    expect(parseCodexThreadCredits(response({ estimatedUsageCreditsMicros: -1 }), 'thread-1')).toBeNull();
    const dropped = parseCodexThreadCredits(response({ groups: [{ estimatedUsageCreditsMicros: 'x' }, 7, null] }), 'thread-1');
    expect(dropped).toMatchObject({ groups: [], totalTokens: null, estimatedUsageCreditsMicros: 12_500_000 });
  });

  it('asks only for the thread it was given, with a time limit', async () => {
    const request = vi.fn().mockResolvedValue(response());
    await expect(readCodexThreadCredits({ request }, 'thread-1')).resolves.toMatchObject({ estimatedUsageCreditsMicros: 12_500_000 });
    expect(request).toHaveBeenCalledWith('account/usage/read', { threadId: 'thread-1' }, 2_500);
  });

  it('returns no reading, without throwing, when this Codex does not support the request', async () => {
    const request = vi.fn().mockRejectedValue(new Error('method not found: account/usage/read'));
    await expect(readCodexThreadCredits({ request }, 'thread-1')).resolves.toBeNull();
  });

  describe('the time limit', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('gives up at the deadline when the app-server never answers, and leaves no timer behind', async () => {
      vi.useFakeTimers();
      const reading = readCodexThreadCredits({ request: vi.fn(() => new Promise(() => { /* wedged */ })) }, 'thread-1', 2_500);
      let settled = false;
      void reading.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(2_499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(reading).resolves.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears its timer when the answer arrives first', async () => {
      vi.useFakeTimers();
      await expect(readCodexThreadCredits({ request: vi.fn().mockResolvedValue(response()) }, 'thread-1')).resolves.toMatchObject({ threadId: 'thread-1' });
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('CodexThreadCreditsLedger', () => {
  it('lets a thread be read once, and only after it ran a turn', () => {
    const ledger = new CodexThreadCreditsLedger();
    expect(ledger.claim('root')).toBe(false);
    ledger.noteTurn('root');
    expect(ledger.claim('root')).toBe(true);
    expect(ledger.claim('root')).toBe(false);
  });

  it('treats the replaced root and its replacement as separate threads', () => {
    const ledger = new CodexThreadCreditsLedger();
    ledger.noteTurn('root');
    expect(ledger.claim('root')).toBe(true);
    ledger.noteTurn('root-2');
    expect(ledger.claim('root-2')).toBe(true);
    expect(ledger.claim('root')).toBe(false);
    expect(ledger.claim('root-3')).toBe(false);
  });
});
