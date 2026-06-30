import type { LoopState } from '../../shared/types/loop.types';

type LoopRuntimeStatusView = Pick<LoopState, 'status' | 'endedAt'>;

export function isTerminalLoopRuntimeStatus(status: LoopState['status']): boolean {
  return (
    status === 'completed' ||
    status === 'completed-needs-review' ||
    status === 'cancelled' ||
    status === 'failed' ||
    status === 'cap-reached' ||
    status === 'error' ||
    status === 'no-progress' ||
    status === 'cost-exceeded' ||
    status === 'needs-human-arbitration' ||
    status === 'reviewer-unreliable' ||
    status === 'reviewer-unavailable' ||
    status === 'builder-unreliable'
  );
}

export function isTerminalLoopRuntimeState(state: LoopRuntimeStatusView): boolean {
  if (state.status === 'provider-limit') {
    return state.endedAt != null;
  }
  return isTerminalLoopRuntimeStatus(state.status);
}

export function isActiveLoopRuntimeState(state: LoopRuntimeStatusView): boolean {
  return (
    state.status === 'running' ||
    state.status === 'paused' ||
    (state.status === 'provider-limit' && state.endedAt == null)
  );
}

export function isParkedLoopRuntimeState(state: LoopRuntimeStatusView): boolean {
  return (
    state.status === 'paused' ||
    (state.status === 'provider-limit' && state.endedAt == null)
  );
}
