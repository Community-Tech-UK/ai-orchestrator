export const INTERRUPT_BOUNDARY_PHASES = ['requested', 'cancelling', 'escalated', 'respawning', 'completed'] as const;
export type InterruptBoundaryPhase = typeof INTERRUPT_BOUNDARY_PHASES[number];

export const INTERRUPT_BOUNDARY_OUTCOMES = ['cancelled', 'cancelled-for-edit', 'respawn-success', 'respawn-fallback', 'unresolved'] as const;
export type InterruptBoundaryOutcome = typeof INTERRUPT_BOUNDARY_OUTCOMES[number];

export interface InterruptBoundaryState {
  phase: InterruptBoundaryPhase;
  outcome: InterruptBoundaryOutcome;
  fallbackMode?: 'native-resume' | 'resume-unconfirmed' | 'replay-fallback';
}
