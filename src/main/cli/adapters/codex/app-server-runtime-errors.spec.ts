import { describe, expect, it } from 'vitest';
import {
  CodexAppServerRuntimeError,
  classifyCodexAppServerFailure,
  isCompactTurnRejection,
} from './app-server-runtime-errors';
import { CodexContextRecoveryPausedError } from './context-cost-controller';

describe('Codex app-server runtime failures', () => {
  it('preserves structured recovery-paused errors from the compaction gate', () => {
    expect(classifyCodexAppServerFailure(
      new CodexContextRecoveryPausedError('Codex compaction stalled', 'compaction-unobserved'),
    )).toMatchObject({ kind: 'recovery-paused', recoverability: 'user-action' });
  });

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
    ['failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }', 'request-rejected', 'retry-thread'],
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

  it.each([
    'failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }',
    'ActiveTurnNotSteerable { "turn_kind": "Compact" }',
  ])('recognises only a provider Compact-turn rejection: %s', (message) => {
    expect(isCompactTurnRejection(new Error(message))).toBe(true);
  });

  it.each([
    'failed to submit turn input: ActiveTurnNotSteerable { turn_kind: User }',
    'failed to submit turn input',
    'RPC timeout: turn/start did not respond',
    'socket closed during turn',
  ])('does not mistake another retryable failure for compaction: %s', (message) => {
    expect(isCompactTurnRejection(new Error(message))).toBe(false);
  });
});
