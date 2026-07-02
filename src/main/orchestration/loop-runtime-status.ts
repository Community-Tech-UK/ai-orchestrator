import type { LoopState } from '../../shared/types/loop.types';

type LoopRuntimeStatusView = Pick<LoopState, 'status' | 'endedAt'>;

type LoopStickyWaitingView = Pick<
  LoopState,
  'status' | 'pausedForInput' | 'terminalIntentPending' | 'pendingInterventions'
>;

/**
 * A3 (#29): true when the loop is (or is about to be) blocked on operator
 * input rather than stalled — a *sticky* waiting state that idle/stall
 * watchdogs must never count toward a kill:
 *  - paused via the BLOCKED.md handshake / a terminal `block` intent
 *    (`pausedForInput`),
 *  - in needs-human-arbitration,
 *  - a `block` intent is pending import, or
 *  - operator input (human message / block override) is queued but not yet
 *    consumed — the loop must get an iteration to act on it before any
 *    stall verdict fires (matching agent-orchestrator's rule that idle
 *    termination needs independent evidence, not just quiet history).
 */
export function isStickyWaitingForInput(state: LoopStickyWaitingView): boolean {
  if (state.status === 'needs-human-arbitration') return true;
  if (state.status === 'paused' && state.pausedForInput === true) return true;
  if (state.terminalIntentPending?.kind === 'block') return true;
  return (state.pendingInterventions ?? []).some(
    (input) => typeof input !== 'string' && (input.source === 'human' || input.source === 'block-override'),
  );
}

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
