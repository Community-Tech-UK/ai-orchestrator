import { describe, expect, it } from 'vitest';
import { CodexAppServerRuntimeError } from './app-server-runtime-errors';
import { planCodexAppServerRecovery } from './app-server-recovery-policy';

describe('Codex app-server recovery policy', () => {
  it.each([
    ['Codex turn stalled: no notifications received for 90000ms', 'retry-turn', true],
    ['HTTP 503 from provider', 'retry-turn', true],
    ['context-cost recovery paused because interruption was unconfirmed', 'request-user-action', true],
    ['thread not found: thread-7', 'replay-thread', false],
    ['unauthorized: login required', 'restart-runtime', false],
  ] as const)('maps %s to %s', (message, action, keepInstanceUsable) => {
    expect(planCodexAppServerRecovery(new Error(message))).toMatchObject({
      action,
      keepInstanceUsable,
    });
  });

  it('uses typed runtime failures without reparsing their message', () => {
    const error = new CodexAppServerRuntimeError({
      kind: 'protocol-invalid',
      message: 'looks like a timeout but is structurally invalid',
      recoverability: 'terminal',
    });

    expect(planCodexAppServerRecovery(error)).toMatchObject({
      action: 'restart-runtime',
      failure: error,
      keepInstanceUsable: false,
    });
  });
});
