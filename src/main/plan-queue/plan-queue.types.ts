export interface PlanQueueSpend { tokens: number; costUsd: number; exactUsd: number }
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
  workerProvider: string | null;
  workerModel: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface PlanQueueItem {
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
  question: PlanQueueQuestion | null;
  answer: string | null;
  parkReason: PlanQueueParkReason | null;
  detail: string | null;
  verdict: PlanQueueVerdict | null;
  createdAt: number;
  updatedAt: number;
}
