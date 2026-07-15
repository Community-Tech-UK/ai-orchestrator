import {
  classifyCodexAppServerFailure,
  type CodexAppServerFailureKind,
  type CodexAppServerRuntimeError,
} from './app-server-runtime-errors';

export type CodexAppServerRecoveryAction =
  | 'retry-turn'
  | 'replay-thread'
  | 'wait-provider'
  | 'request-user-action'
  | 'restart-runtime';

export interface CodexAppServerRecoveryDecision {
  action: CodexAppServerRecoveryAction;
  failure: CodexAppServerRuntimeError;
  keepInstanceUsable: boolean;
}

const RETRYABLE_FAILURES = new Set<CodexAppServerFailureKind>([
  'transport-closed',
  'request-timeout',
  'turn-stalled',
  'turn-failed',
]);

/** One recovery policy for app-server transport, turn, and resume failures. */
export function planCodexAppServerRecovery(error: unknown): CodexAppServerRecoveryDecision {
  const failure = classifyCodexAppServerFailure(error);
  if (RETRYABLE_FAILURES.has(failure.kind)) {
    return { action: 'retry-turn', failure, keepInstanceUsable: true };
  }
  if (failure.kind === 'provider-limit') {
    return { action: 'wait-provider', failure, keepInstanceUsable: true };
  }
  if (failure.kind === 'recovery-paused') {
    return { action: 'request-user-action', failure, keepInstanceUsable: true };
  }
  if (failure.kind === 'thread-unavailable') {
    return { action: 'replay-thread', failure, keepInstanceUsable: false };
  }
  return { action: 'restart-runtime', failure, keepInstanceUsable: false };
}
