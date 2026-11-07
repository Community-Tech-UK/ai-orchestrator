export interface PlanQueueSpend { tokens: number; costUsd: number; exactUsd: number; unpricedTokens?: number }
export interface PlanQueueSpendEntry {
  id: string; runId: string; itemId: string | null; role: string; round: number | null;
  provider: string | null; model: string | null; processed: number; output: number;
  costUsd: number | null; costBasis: 'exact' | 'estimated' | 'unknown'; createdAt: number;
}
import type {
  PlanQueueItemState,
  PlanQueueKind,
  PlanQueueParkReason,
  PlanQueueQuestion,
  PlanQueueRunConfig,
  PlanQueueRunStatus,
  PlanQueueVerdict,
} from '@contracts/schemas/plan-queue';

/** Settings the run overrode, with the value to put back and the value applied. */
export interface PlanQueueRelaxationSnapshot {
  entries: { key: string; original: unknown; applied: unknown }[];
}

export interface PlanQueueRun {
  spend?: PlanQueueSpend;
  id: string;
  parentInstanceId: string;
  /**
   * The parent's conversation thread. Instance ids change at every restart;
   * the thread is how the run finds its restored parent (plan-queue-parent.ts).
   */
  parentHistoryThreadId: string | null;
  kind: PlanQueueKind;
  workspaceCwd: string;
  status: PlanQueueRunStatus;
  config: PlanQueueRunConfig;
  relaxation: PlanQueueRelaxationSnapshot | null;
  /** Why the run has stopped starting new work after a shared failure; live work carries on. */
  holdReason?: string | null;
  workerProvider: string | null;
  workerModel: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface PlanQueueWorkerSession {
  provider: string;
  model: string | null;
  accountProfileId: string | null;
  providerSessionId: string;
  workingDirectory: string;
  recordedAt: number;
}

export interface PlanQueueItem {
  workerSession?: PlanQueueWorkerSession;
  /** Paused work retains its branch and pending next-turn instructions. */
  heldAt?: number | null;
  pendingInstruction?: string | null;
  spend?: PlanQueueSpend;
  id: string;
  runId: string;
  /** Absolute path of the document in the ROOT checkout (never the worktree). */
  documentPath: string;
  state: PlanQueueItemState;
  round: number;
  erroredRounds: number;
  /** Landing refusals (hook or active documents) since the item last landed or parked. */
  landingRefusals: number;
  /** Returns to the worker for a base-branch conflict or failed post-merge check since the item last landed or was resumed. */
  baseConflicts: number;
  /**
   * When a landing first found the root checkout's uncommitted code in its way, and which paths. Both are written only
   * while the state is `landing` (the store drops them on any other state). The paths are empty once the wait has
   * ended and a landing attempt is running; the time stays so the 24-hour limit is counted from the first wait.
   */
  landingWaitSince?: number | null;
  landingWaitPaths?: string[];
  /** Set by Discard. The job stays parked but leaves the Set aside list. */
  discardedAt?: number | null;
  discardedBy?: string | null;
  /** When the reference keeping its work expires; null when none is held (see plan-queue-discard.ts). */
  discardRefExpiresAt?: number | null;
  branchName: string | null;
  worktreePath: string | null;
  baseCommit: string | null;
  /** Last coordinator safety commit on the item branch. */
  checkpointCommit: string | null;
  /** `main` tip the current verification is judging against. */
  verifiedMainCommit: string | null;
  landedCommit: string | null;
  workerInstanceId: string | null;
  verifierInstanceId: string | null;
  /** Provider and model the latest worker session ran on; checkers are chosen against them. */
  workerProvider?: string;
  workerModel?: string;
  /** Debugging port of the dev app a livetest worker launches; checked free when its worker starts. */
  livetestPort?: number | null;
  /** When the document was handed to the run's step-up worker; set once, never cleared. */
  steppedUpAt?: number | null;
  question: PlanQueueQuestion | null;
  answer: string | null;
  parkReason: PlanQueueParkReason | null;
  detail: string | null;
  verdict: PlanQueueVerdict | null;
  createdAt: number;
  updatedAt: number;
}
