/**
 * The work-source boundary: everything the queue needs to know about WHERE its work comes from, so the rest of the
 * queue (scheduling, workers, checkers, landing) deals only in items.
 *
 * Today the only source is markdown files (`plan-queue-markdown-source.ts`): the run's items are plan and livetest
 * documents. Each fact keeps one owner (docs/plans/2026-11-03-plan-queue-autonomy-and-linear_plan.md, "One owner for
 * each fact"): the source owns what the work is and how it is closed; the queue database owns how the run went.
 *
 * An item's stored source reference is `PlanQueueItem.sourceRef` (the `document_path` column, a persisted legacy
 * name): the absolute path of the file for markdown. Callers never open it directly; they ask the item's source.
 * Methods are added to this interface when a caller needs them, and no earlier.
 */

import type { PlanQueueFinding, PlanQueueKind, PlanQueueQuestion, PlanQueueParkReason, PlanQueueSourceKind } from '@contracts/schemas/plan-queue';
import type { DirtyOverlapResolver } from '../workspace/git/dirty-overlap.types';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PreparedDocuments } from './plan-queue-doc-close';
import type { DirectChange } from './plan-queue-direct-changes';
import type { DocumentReview } from './plan-queue-document-review';
import type { PlanQueueGateReceipt } from './plan-queue-gate-receipts';
import type { PlanQueueHistoryStore } from './plan-queue-history-store';
import type { PlanQueueItemPin } from './plan-queue-plan-pins';
import type { ItemPromptContext } from './plan-queue-prompts';
import type { PlanQueueStore } from './plan-queue-store';
import type { RememberedOutcome } from './plan-queue-triage-memory';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

/** A piece of work a source found, before it becomes an item. */
export interface WorkCandidate {
  /** Becomes `PlanQueueItem.sourceRef`. */
  ref: string;
  readiness: 'candidate' | 'not-ready';
  reason?: string | null;
}

export interface WorkDiscoveryQuery {
  kind: PlanQueueKind;
  glob?: string;
}

/** The source reference of an item, with the kind that says how to read it. */
export type WorkItemRef = Pick<PlanQueueItem, 'sourceRef' | 'sourceKind'>;
/** An item's reference with its own id, for a source that keeps the work's text per item (a ticket's approved text). */
export type WorkItemId = Pick<PlanQueueItem, 'id' | 'sourceRef' | 'sourceKind'>;

/**
 * Commit-message prefixes the interrupted-landing recogniser accepts (`plan-queue-landing-leftover.ts`): every
 * source's `commitSubject` must start with one of these followed by ': '. `Ticket` is the prefix Linear items will
 * use (`Ticket: <identifier>`); it is listed ahead of that source so a landing interrupted by an older build is
 * still recognised after the source arrives.
 */
export const LANDING_COMMIT_PREFIXES = ['Plan', 'Livetest', 'Ticket'] as const;
export type LandingCommitPrefix = (typeof LANDING_COMMIT_PREFIXES)[number];

export type LandingMergeRecovery = { ok: true; mergedPaths: string[] } | { ok: false; reason: string };
export type InterruptedMergeStore = Pick<PlanQueueStore, 'listWorkspaceRoots' | 'getItem' | 'getRun' | 'upsertItem'>;

/** Why a job may not start now. `setAside`: it can never start, so the pump sets it aside instead of leaving it waiting. */
export interface WorkItemHold {
  note: string;
  setAside: boolean;
  /**
   * The question James must answer, when the job is held by one. The pump puts it back on a job that lost it (a shutdown
   * between the hold and the saving of the question), so a held job never waits on a question nobody can see.
   */
  question?: PlanQueueQuestion;
}

/** What a worker prompt is built from before the source reads the work itself. */
export type WorkerPromptBase = Omit<ItemPromptContext, 'brief'> & {
  /** True when this job's step writes the plan's as-built summary (markdown plans only). */
  lastStepOfRun: boolean;
};

/** Every prompt a worker is given. Each is built from the work as it is now, and for a ticket from its approved text only. */
export interface QueueWorkerPrompts {
  first(base: WorkerPromptBase): Promise<string>;
  resume(base: WorkerPromptBase, reason: string): Promise<string>;
  stepUp(base: WorkerPromptBase, failedRounds: number, findings: readonly PlanQueueFinding[]): Promise<string>;
  /** After a failed check. `planningNote` says which planning files the coordinator moved out of the work folder. */
  fix(run: PlanQueueRun, item: PlanQueueItem, round: number, maxRounds: number, findings: readonly PlanQueueFinding[], planningNote: string | null | undefined, directChanges: readonly DirectChange[]): Promise<string>;
}

export interface CheckerPromptInput {
  run: PlanQueueRun;
  item: PlanQueueItem;
  baseBranch: string;
  receipts: readonly PlanQueueGateReceipt[];
  diffStat: string;
  /** The earlier failed rounds, as JSON, or undefined in the first round. */
  earlierRounds: string | undefined;
  /** What the work looked like when the job started. */
  pin: PlanQueueItemPin | undefined;
  /** Files changed on the base branch since the job began that this job must keep (`plan-queue-direct-changes.ts`). */
  directChanges: readonly DirectChange[];
}

export interface QueueWorkSource {
  readonly kind: PlanQueueSourceKind;

  // --- Discovery and readiness -------------------------------------------------------------------------------
  /** What is there to do in this repository, in the order the run should start it. */
  discover(repoRoot: string, query: WorkDiscoveryQuery): Promise<WorkCandidate[]>;
  /** The stored reference for a reference the triage agent reported, which may be relative to the repository. */
  resolveRef(run: PlanQueueRun, reported: string): string;
  /** A candidate that is only a prerequisite of other work (a spec waiting for its plan) and must stay open. */
  awaitsPlan(candidate: WorkCandidate): boolean;
  /**
   * How a candidate too big for one job splits into jobs: its step numbers, one job each; `[]` when every step is
   * already done; null when it stays one job (or has no steps to split by).
   */
  stepJobs(candidate: WorkCandidate, run: PlanQueueRun): number[] | null;
  /** Why a bulk start leaves the candidate out, or null. `section` is the first step job's number, when it splits. */
  leftOutNote(candidate: WorkCandidate, run: PlanQueueRun, store: PlanQueueStore, section: number | null): string | null;
  /** A decision remembered for this unchanged work, which replaces triage. */
  rememberedOutcome(candidate: WorkCandidate, run: PlanQueueRun, memory: PlanQueueHistoryStore | undefined): RememberedOutcome;
  /** Retire or park the untouched, waiting items of a run whose work has gone or been replaced. */
  reconcileWaiting(host: Pick<PlanQueueFlowHost, 'getRun' | 'getItem' | 'transition' | 'notifyParent' | 'store'>, run: PlanQueueRun): Promise<void>;
  /** Why a started item can no longer be checked against its work, or null when it can. */
  missingNote(item: WorkItemRef, run: PlanQueueRun): Promise<string | null>;
  /**
   * Why this run may not start new work now, or null. Asked by the pump before a check, triage or a worker starts, and
   * by the page's run data. Work already running carries on, and the run's own `holdReason` and the breaker are not
   * touched: the reason is the source's, and it clears itself when the source can be used again.
   */
  reasonToHold(run: PlanQueueRun): string | null;
  /**
   * Why this one job may not start now, or null: the item-level twin of `reasonToHold`. Asked by the pump for a check and
   * for a worker, from stored data only, so it never calls anything outside the app. `runItems` are the run's jobs.
   * Markdown never holds a job.
   */
  itemHold(item: PlanQueueItem, runItems: readonly PlanQueueItem[]): WorkItemHold | null;
  /**
   * Called before any session is created for the job, and before a turn is sent to a live worker. Throws
   * `PlanQueueTicketHeld` when the work changed since it was approved or cannot be checked; the job is then held, not
   * failed. Markdown reads its document when a prompt is built, so it has nothing to check.
   */
  assertReadyForSession(item: WorkItemId, run: PlanQueueRun): Promise<void>;
  /**
   * Called when a set-aside job is resumed, before it is moved back to the queue. A source that deletes the work's text after a
   * time (a ticket's, `plan-queue-ticket-retention.ts`) reads the work again here when the text is gone and asks James, and it
   * names the job so nothing deletes its text before the Resume ends. Throws, and changes nothing, when the work cannot be
   * read now. The caller calls the returned function once the Resume is over, whether or not it worked.
   */
  beginResume(item: WorkItemId, run: PlanQueueRun): Promise<() => void>;

  // --- Rounds: what is reviewed, what counts as progress, what a session is told -------------------------------
  /** What the checker reviewed, as a fingerprint. A PASS cannot stand when it differs when the check ends or the work lands. */
  reviewFingerprint(item: WorkItemId): Promise<DocumentReview>;
  /** A hash of the work's content for the no-progress check; null when it cannot be read, which is never "unchanged". */
  contentHash(item: WorkItemId): Promise<string | null>;
  /** The pin recorded when a job starts; null when the work cannot be read, which sets the job aside as a missing document. */
  readPin(item: WorkItemId, recordedAt: number): Promise<PlanQueueItemPin | null>;
  /** Whether the work is big enough to need the session's large-document setting. */
  isLarge(item: WorkItemId): boolean;
  /** At every checkpoint of the work folder: trim what the source keeps in the work itself. Never blocks the checkpoint. */
  trimAtCheckpoint(item: PlanQueueItem, memory?: PlanQueueHistoryStore): Promise<void>;
  /** The plan-specific text a worker is told: a worker's turn is built from the work as it is now. */
  readonly workerPrompts: QueueWorkerPrompts;
  /** What a step-up worker is asked for; also saved as the item's pending instruction. */
  stepUpInstruction(failedRounds: number, findings: readonly PlanQueueFinding[]): string;
  /** The checker's prompt. */
  checkerPrompt(input: CheckerPromptInput): Promise<string>;

  // --- Landing and listing ---------------------------------------------------------------------------------------
  /** Why work that is one step of something bigger cannot land, or null. */
  landingProblem(item: PlanQueueItem): Promise<string | null>;
  /** After code landed with the work left open: what the source tells a person about it. Returns notes for the item. */
  noteOpenLanding(item: PlanQueueItem, run: PlanQueueRun, jobsOfRun: () => readonly PlanQueueItem[]): Promise<string[]>;
  /** How the Set aside list names a job's work and describes its state. */
  setAsideView(item: WorkItemRef, folder: string): Promise<{ document: string; documentState: string }>;
  /** The name a row shows, or null to let the page name it from the reference. */
  rowTitle(item: WorkItemRef): string | null;

  // --- Parked notes ------------------------------------------------------------------------------------------
  /** Leave a note where a person will find a parked branch. Returns a failure sentence, or null. */
  appendParkNote(item: PlanQueueItem, run: PlanQueueRun, reason: PlanQueueParkReason, history: PlanQueueHistoryStore): Promise<string | null>;
  /** Take this item's note off again; returns the byte change to record, if any. */
  removeParkNote(item: WorkItemRef, branchName: string): Promise<{ beforeSha256: string; afterSha256: string } | undefined>;

  // --- Closing the work at landing ---------------------------------------------------------------------------
  /** Throws when the work changed since the checker reviewed it. A ticket runs the check before a session, and holds the landing. */
  assertUnchangedSince(item: WorkItemId, reviewed: DocumentReview, run: PlanQueueRun): Promise<void>;
  /** The closed copies that go into the landing commit, or the instruction to close in place. */
  prepareClose(item: PlanQueueItem, repoRoot: string, worktreePath: string | null, reviewed: DocumentReview): Promise<PreparedDocuments>;
  /** After the code reached the base branch: retire what it superseded. Returns notes for the item. */
  finishClose(item: PlanQueueItem, repoRoot: string, baseBranch: string, reviewed: DocumentReview): Promise<string[]>;

  // --- Landing merges with the root checkout's uncommitted edits ---------------------------------------------
  overlapResolver(itemId: string): DirtyOverlapResolver;
  /** Settle a conflict in a file the source knows how to merge; false leaves it for the worker. */
  resolveSyncConflict(worktreePath: string, conflictFiles: readonly string[]): Promise<boolean>;
  /** Read-only: would promotion merge this uncommitted root file? */
  rootEditWouldMerge(repoRoot: string, baseTip: string, itemHead: string, file: string): Promise<boolean>;
  /** A landing interrupted after a merge was recorded: finish putting the person's edits back. */
  recoverLandingMerge(repoRoot: string, itemId: string): Promise<LandingMergeRecovery>;
  /** Boot: finish every landing merge an earlier run of the app left half done. */
  recoverInterruptedMerges(store: InterruptedMergeStore): Promise<void>;

  // --- Names and landing text --------------------------------------------------------------------------------
  /** Session names, run summaries and phone rows. */
  displayName(item: WorkItemRef): string;
  /** The readable part of the item's branch name (the caller sanitises it and adds the item's own suffix). */
  branchSlug(item: WorkItemRef): string;
  /** The name with its file extension, where the kind of thing matters: the step-up notice and a new work folder's label. */
  fullName(item: WorkItemRef): string;
  /** The line that ties a checkpoint commit to its work. */
  checkpointTrailer(item: WorkItemRef): string;
  /** First line of the landing commit; starts with one of `LANDING_COMMIT_PREFIXES` and ': '. */
  commitSubject(item: Pick<PlanQueueItem, 'sourceRef' | 'sourceKind' | 'section'>, run: Pick<PlanQueueRun, 'kind'>): string;
}
