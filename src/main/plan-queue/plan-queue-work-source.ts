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

import type { PlanQueueKind, PlanQueueParkReason, PlanQueueSourceKind } from '@contracts/schemas/plan-queue';
import type { DirtyOverlapResolver } from '../workspace/git/dirty-overlap.types';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PreparedDocuments } from './plan-queue-doc-close';
import type { DocumentReview } from './plan-queue-document-review';
import type { PlanQueueHistoryStore } from './plan-queue-history-store';
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

  // --- Parked notes ------------------------------------------------------------------------------------------
  /** Leave a note where a person will find a parked branch. Returns a failure sentence, or null. */
  appendParkNote(item: PlanQueueItem, run: PlanQueueRun, reason: PlanQueueParkReason, history: PlanQueueHistoryStore): Promise<string | null>;
  /** Take this item's note off again; returns the byte change to record, if any. */
  removeParkNote(item: WorkItemRef, branchName: string): Promise<{ beforeSha256: string; afterSha256: string } | undefined>;

  // --- Closing the work at landing ---------------------------------------------------------------------------
  /** Throws when the work changed since the checker reviewed it. */
  assertUnchangedSince(item: WorkItemRef, reviewed: DocumentReview): Promise<void>;
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
