import { describe, expect, it } from 'vitest';
import {
  CodexAppServerRuntimeError,
  classifyCodexAppServerFailure,
} from './app-server-runtime-errors';

describe('Codex app-server runtime failures', () => {
  it('preserves an existing typed failure', () => {
    const failure = new CodexAppServerRuntimeError({
      kind: 'transport-closed',
      message: 'connection closed',
      recoverability: 'retry-thread',
    });

    expect(classifyCodexAppServerFailure(failure)).toBe(failure);
  });

  it.each([
    ['RPC timeout: turn/start did not respond', 'request-timeout', 'retry-thread'],
    ['Codex turn stalled: no notifications received for 90000ms', 'turn-stalled', 'retry-thread'],
    ['thread not found: thread-123', 'thread-unavailable', 'replay-required'],
    ['unauthorized: login required', 'authentication', 'terminal'],
    ['context-cost recovery paused because interruption was unconfirmed', 'recovery-paused', 'user-action'],
  ] as const)('classifies %s as %s', (message, kind, recoverability) => {
    expect(classifyCodexAppServerFailure(new Error(message))).toMatchObject({
      kind,
      recoverability,
      message,
    });
  });

  it('does not call generic transport silence thread loss', () => {
    expect(classifyCodexAppServerFailure(new Error('socket closed during turn'))).toMatchObject({
      kind: 'transport-closed',
      recoverability: 'retry-thread',
    });
  });
});
