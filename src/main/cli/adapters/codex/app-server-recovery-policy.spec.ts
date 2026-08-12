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

  it('treats an "already has an active turn" collision as a retryable scheduling race, not a runtime failure (LT-050)', () => {
    // Mirrors exactly how CodexAppServerThreadRuntime.captureTurn throws this error
    // (app-server-thread-runtime.ts) when a second turn (e.g. an orchestration inject-response)
    // is attempted while the instance's own turn is still active.
    const error = new CodexAppServerRuntimeError({
      kind: 'request-rejected',
      message: 'Codex app-server runtime already has an active turn',
      recoverability: 'retry-thread',
    });

    expect(planCodexAppServerRecovery(error)).toMatchObject({
      action: 'retry-turn',
      failure: error,
      keepInstanceUsable: true,
    });
  });

  it('still treats an unrelated "request-rejected" failure (e.g. an invalid model) as unrecoverable', () => {
    // classifyMessage() labels this case 'terminal', not 'retry-thread' — the fix for the
    // active-turn collision above must not broaden every 'request-rejected' kind.
    const error = new CodexAppServerRuntimeError({
      kind: 'request-rejected',
      message: 'unknown model: gpt-not-a-real-model',
      recoverability: 'terminal',
    });

    expect(planCodexAppServerRecovery(error)).toMatchObject({
      action: 'restart-runtime',
      failure: error,
      keepInstanceUsable: false,
    });
  });
});
