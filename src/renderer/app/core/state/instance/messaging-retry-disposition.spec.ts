import { describe, expect, it } from 'vitest';
import { canRestartForTerminalSend, getRetryDisposition } from './messaging-retry-disposition';

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
});
