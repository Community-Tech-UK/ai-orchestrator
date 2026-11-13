import type { InterruptBoundaryOutcome, InterruptBoundaryPhase, InterruptBoundaryState } from '../types/interrupt-boundary.types';

// Redundant lifecycle receipts: desktop suppresses these beside the boundary;
// phone, history and exports still receive plain copy.
export const INTERRUPT_SETTLED_NOTICE = 'Stopped. Ready for your next message.';
export const INTERRUPT_RESTARTED_NOTICE = 'Stopped. The session restarted because its history could not be resumed.';

const PHASE_COPY: Record<Exclude<InterruptBoundaryPhase, 'completed'>, string> = {
  requested: 'Stopping…',
  cancelling: 'Stopping…',
  escalated: "The agent didn't stop, so Harness forced it to stop.",
  respawning: 'Restarting the session…',
};
const OUTCOME_COPY: Record<InterruptBoundaryOutcome, string> = {
  cancelled: 'The agent stopped.',
  'cancelled-for-edit': 'Stopped so you can edit your message.',
  'respawn-success': 'Stopped. The session restarted and kept its history.',
  'respawn-fallback': 'Stopped. The session restarted with only your recent messages carried over, so earlier detail may be missing.',
  unresolved: 'Stop was requested but not confirmed. The agent may still be running.',
};

export function describeInterruptBoundary(state: InterruptBoundaryState): string {
  if (state.phase === 'completed') {
    if (state.fallbackMode === 'resume-unconfirmed' && (state.outcome === 'respawn-success' || state.outcome === 'respawn-fallback')) {
      return "Stopped. The session restarted, but Harness couldn't confirm it kept its history.";
    }
    return OUTCOME_COPY[state.outcome];
  }
  return state.phase === 'cancelling' && state.outcome === 'cancelled-for-edit'
    ? 'Stopping so you can edit your message…'
    : PHASE_COPY[state.phase];
}
