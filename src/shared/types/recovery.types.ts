import type { ActivityState } from './activity.types';

/** Every known failure mode gets a typed entry */
export type FailureCategory =
  | 'thread_resume_failed'
  | 'process_exited_unexpected'
  | 'agent_stuck_blocked'
  | 'agent_stuck_waiting'
  | 'mcp_server_unreachable'
  | 'provider_auth_expired'
  | 'context_window_exhausted'
  | 'workspace_disappeared'
  | 'stale_branch'
  | 'ci_feedback_loop'
  ;

/** A detected failure ready for recovery */
export interface DetectedFailure {
  /** Unique failure ID */
  id: string;
  /** Which failure category this belongs to */
  category: FailureCategory;
  /** Which instance experienced this failure */
  instanceId: string;
  /** When the failure was detected (epoch ms) */
  detectedAt: number;
  /** Category-specific details */
  context: Record<string, unknown>;
  /** Activity state at detection time */
  activityState?: ActivityState;
  /** How severe this failure is */
  severity: 'recoverable' | 'degraded' | 'fatal';
}

/** A registered recovery recipe for a failure category */
export interface RecoveryRecipe {
  /** Which failure category this recipe handles */
  category: FailureCategory;
  /** Expected severity — used for categorization */
  severity: 'recoverable' | 'degraded' | 'fatal';
  /** Maximum auto-recovery attempts before escalating */
  maxAutoRetries: number;
  /** Minimum time between auto-recovery attempts (ms) */
  cooldownMs: number;
  /** Execute the recovery action */
  recover: (failure: DetectedFailure) => Promise<RecoveryOutcome>;
  /** Human-readable description */
  description: string;
}

/** Result of a recovery attempt */
export type RecoveryOutcome =
  | { status: 'recovered'; action: string }
  | { status: 'degraded'; action: string }
  | { status: 'escalated'; reason: string }
  | { status: 'aborted'; reason: string }
  ;

/** A logged recovery attempt */
export interface RecoveryAttempt {
  /** ID of the failure that triggered this attempt */
  failureId: string;
  /** Category of the failure */
  category: FailureCategory;
  /** Instance that was recovered */
  instanceId: string;
  /** When the attempt was made (epoch ms) */
  attemptedAt: number;
  /** Outcome of the recovery */
  outcome: RecoveryOutcome;
  /** Checkpoint created before recovery (rollback point) */
  checkpointId: string;
}

/** Global circuit breaker constants */
export const RECOVERY_CONSTANTS = {
  /** Max total recovery attempts per instance within the time window */
  CIRCUIT_BREAKER_MAX_ATTEMPTS: 5,
  /** Time window for circuit breaker (ms) */
  CIRCUIT_BREAKER_WINDOW_MS: 600_000, // 10 minutes
} as const;
