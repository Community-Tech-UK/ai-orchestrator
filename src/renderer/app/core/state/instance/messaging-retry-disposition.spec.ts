import { describe, expect, it } from 'vitest';
import {
  canRestartForTerminalSend,
  getRetryDisposition,
  isProviderCompactingRejection,
  COMPACT_TURN_RETRY_DELAY_MS,
  MAX_COMPACT_TURN_RETRIES,
} from './messaging-retry-disposition';

describe('messaging-retry-disposition', () => {
  it('parks send-input timeouts as idle without retry', () => {
    expect(getRetryDisposition('busy', 'Send input timed out after 30s')).toEqual({
      shouldRetry: false,
      nextStatus: 'idle',
    });
  });

  it('retries an overlapping Codex turn as busy', () => {
    expect(getRetryDisposition('idle', 'previous turn is still running')).toEqual({
      shouldRetry: true,
      nextStatus: 'busy',
    });
  });

  it('retries interrupt recovery and missing-instance as terminal', () => {
    expect(getRetryDisposition('respawning', 'recovering from interrupt')).toEqual({
      shouldRetry: true,
      nextStatus: 'respawning',
    });
    expect(getRetryDisposition('idle', 'Instance abc not found')).toEqual({
      shouldRetry: false,
      nextStatus: 'terminated',
    });
  });

  it('restarts only terminal send statuses', () => {
    expect(canRestartForTerminalSend('terminated')).toBe(true);
    expect(canRestartForTerminalSend('cancelled')).toBe(true);
    expect(canRestartForTerminalSend('idle')).toBe(false);
  });

  // LT-652 — session xecsi91o3 burned 5 retries in 622 ms against one Compact turn.
  it('recognises a Codex compaction-turn rejection', () => {
    expect(
      isProviderCompactingRejection(
        'Codex error: failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }',
      ),
    ).toBe(true);
    expect(isProviderCompactingRejection('previous turn is still running')).toBe(false);
  });

  it('does not treat an unrelated submit failure as a compaction wait', () => {
    // A bare submit failure (or a non-Compact turn_kind) must stay on the fast
    // 2 s × 5 path — the compact budget would hide it for ~180 s.
    expect(
      isProviderCompactingRejection('Codex error: failed to submit turn input: thread busy'),
    ).toBe(false);
    expect(
      isProviderCompactingRejection('ActiveTurnNotSteerable { turn_kind: User }'),
    ).toBe(false);
    expect(
      getRetryDisposition('idle', 'Codex error: failed to submit turn input: thread busy'),
    ).toEqual({ shouldRetry: true });
    expect(
      getRetryDisposition('idle', 'ActiveTurnNotSteerable { turn_kind: User }'),
    ).toEqual({ shouldRetry: true });
  });

  it('holds a Compact-turn rejection with a long backoff and a compact-sized retry budget', () => {
    expect(
      getRetryDisposition(
        'idle',
        'Codex error: failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }',
      ),
    ).toEqual({
      shouldRetry: true,
      retryAfterMs: COMPACT_TURN_RETRY_DELAY_MS,
      maxRetries: MAX_COMPACT_TURN_RETRIES,
    });
    // No nextStatus: the instance is already idle (the Compact turn is invisible
    // to AIO turn tracking). Parking it on 'busy' would block every drain.
    expect(COMPACT_TURN_RETRY_DELAY_MS).toBeGreaterThanOrEqual(10_000);
  });
});
