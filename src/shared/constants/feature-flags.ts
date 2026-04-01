/**
 * Feature flags for optional orchestration systems.
 * Set to false to prevent lazy-loading of unused coordinators.
 */
export const ORCHESTRATION_FEATURES = {
  DEBATE_SYSTEM: true,
  VERIFICATION_SYSTEM: true,
  CONSENSUS_SYSTEM: true,
  PARALLEL_WORKTREE: true,
} as const;

export type OrchestrationFeature = keyof typeof ORCHESTRATION_FEATURES;
