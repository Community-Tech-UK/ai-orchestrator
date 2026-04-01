/**
 * Typed Progress Events for Orchestration Coordinators
 *
 * These types provide type-safe progress tracking for the Angular frontend.
 * Each coordinator has a dedicated progress type with phase tracking that
 * mirrors the actual EventEmitter events emitted at runtime.
 *
 * Note: DebateStreamEvent (in debate-coordinator.ts) covers the streaming API.
 * DebateProgress here maps to the EventEmitter-based progress events.
 */

/**
 * Debate progress — mirrors EventEmitter events from DebateCoordinator.
 *
 * Relevant events: debate:started, debate:round-complete, debate:early-terminated,
 * debate:completed, debate:error
 */
export interface DebateProgress {
  type: 'debate';
  debateId: string;
  phase:
    | 'initial'
    | 'critique'
    | 'defense'
    | 'synthesis'
    | 'completed'
    | 'early_terminated'
    | 'error';
  /** Current round number (1-based, 0 before first round completes) */
  currentRound: number;
  /** Maximum configured rounds */
  maxRounds: number;
  /** Consensus score from the most recent completed round (0–1) */
  consensusScore: number;
  /** Duration of the debate so far in milliseconds */
  durationMs: number;
}

/**
 * Verification coordinator progress — mirrors EventEmitter events from MultiVerifyCoordinator.
 *
 * Relevant events: verification:progress (carries VerificationProgress payload),
 * verification:agents-launching, verification:completed, verification:error
 *
 * The phase values match VerificationProgress['phase'] in verification.types.ts.
 * Named VerificationCoordinatorProgress to avoid collision with VerificationProgress
 * already exported from verification.types.ts.
 */
export interface VerificationCoordinatorProgress {
  type: 'verification';
  requestId: string;
  phase: 'spawning' | 'collecting' | 'analyzing' | 'synthesizing' | 'complete';
  completedAgents: number;
  totalAgents: number;
  /** Human-readable description of the current activity */
  currentActivity: string;
}

/**
 * Worktree parallel execution progress — mirrors EventEmitter events from
 * ParallelWorktreeCoordinator.
 *
 * Relevant events: execution:created, execution:started, execution:merging,
 * execution:conflicts-detected, execution:partial-failure, execution:completed,
 * execution:cancelled, task:completed, task:merged, task:merge-failed
 */
export interface WorktreeProgress {
  type: 'worktree';
  executionId: string;
  phase:
    | 'creating'
    | 'running'
    | 'merging'
    | 'conflicts_detected'
    | 'completed'
    | 'partial_failure'
    | 'cancelled';
  /** Number of tasks that have signalled task:completed */
  tasksComplete: number;
  /** Total tasks in this execution */
  totalTasks: number;
  /** Number of conflicts currently blocking the merge step */
  conflictsDetected: number;
  /** Number of tasks whose merge failed */
  failedMerges: number;
}

/**
 * Consensus query progress — mirrors EventEmitter events from ConsensusCoordinator.
 *
 * Relevant event: consensus:progress (carries ConsensusProgressEvent payload).
 * The phase values match ConsensusProgressEvent['phase'] in consensus.types.ts.
 */
export interface ConsensusProgress {
  type: 'consensus';
  queryId: string;
  phase: 'dispatching' | 'collecting' | 'synthesizing' | 'complete' | 'error';
  /** Provider names that have responded so far */
  respondedProviders: string[];
  /** Provider names still awaiting a response */
  pendingProviders: string[];
}

/**
 * Discriminated union of all coordinator progress types.
 * Use the `type` field to narrow to a specific coordinator.
 */
export type CoordinatorProgress =
  | DebateProgress
  | VerificationCoordinatorProgress
  | WorktreeProgress
  | ConsensusProgress;
