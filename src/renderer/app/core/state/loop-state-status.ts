import type { LoopStatePayload } from '@contracts/schemas/loop';
import type { LoopFinalSummary } from './loop-store.types';

export function isActiveLoopStatePayload(state: LoopStatePayload): boolean {
  return (
    state.status === 'running'
    || state.status === 'paused'
    || (state.status === 'provider-limit' && state.endedAt == null)
  );
}

export function isTerminalLoopStatePayload(
  state: LoopStatePayload,
): state is LoopStatePayload & { status: LoopFinalSummary['status'] } {
  if (state.status === 'provider-limit') {
    return state.endedAt != null;
  }
  return isTerminalLoopStatusPayload(state.status);
}

function isTerminalLoopStatusPayload(
  status: LoopStatePayload['status'],
): status is Exclude<LoopFinalSummary['status'], 'provider-limit'> {
  return (
    status === 'completed'
    || status === 'completed-needs-review'
    || status === 'cancelled'
    || status === 'failed'
    || status === 'cap-reached'
    || status === 'error'
    || status === 'no-progress'
    || status === 'cost-exceeded'
    || status === 'needs-human-arbitration'
    || status === 'reviewer-unreliable'
    || status === 'reviewer-unavailable'
    || status === 'builder-unreliable'
  );
}
