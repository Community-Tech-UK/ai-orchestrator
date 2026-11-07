/**
 * Plan Queue item state machine — pure functions, no I/O.
 *
 * Every item ends in exactly one of `landed`, `parked` or `skipped`. Any
 * non-terminal state may park, so a failure anywhere still reaches a terminal
 * state whose teardown checkpoints the work first.
 */
import type { PlanQueueItemState } from '@contracts/schemas/plan-queue';
import type { PlanQueueItem } from './plan-queue.types';

const TERMINAL_STATES: ReadonlySet<PlanQueueItemState> = new Set<PlanQueueItemState>([
  'landed',
  'parked',
  'skipped',
]);

const TRANSITIONS: Readonly<Record<PlanQueueItemState, readonly PlanQueueItemState[]>> = {
  discovered: ['queued', 'needs-answer', 'skipped'],
  'needs-answer': ['queued', 'skipped'],
  queued: ['preparing', 'skipped'],
  preparing: ['working', 'queued'],
  working: ['awaiting-slot', 'queued'],
  fixing: ['awaiting-slot', 'queued'],
  'awaiting-slot': ['verifying', 'fixing'],
  verifying: ['landing', 'fixing', 'awaiting-slot'],
  landing: ['landed', 'fixing', 'awaiting-slot'],
  landed: [],
  // Resume and "Land anyway" are operator actions on a parked branch.
  parked: ['queued', 'landing'],
  skipped: [],
};

export function isTerminalItemState(state: PlanQueueItemState): boolean {
  return TERMINAL_STATES.has(state);
}

/** States in which the item owns a worktree directory on disk. */
export function itemHoldsWorktree(state: PlanQueueItemState): boolean {
  return (
    state === 'preparing'
    || state === 'working'
    || state === 'fixing'
    || state === 'awaiting-slot'
    || state === 'verifying'
    || state === 'landing'
  );
}

/** A landing that is waiting for the root checkout's uncommitted code to clear; it holds no lock and runs nothing. */
export function isLandingWait(item: Pick<PlanQueueItem, 'state' | 'landingWaitPaths'>): boolean {
  return item.state === 'landing' && (item.landingWaitPaths?.length ?? 0) > 0;
}

/**
 * Counts toward a run's worker slots. A waiting landing still keeps its folder (it counts toward the app-wide
 * limit through `itemHoldsWorktree`) but frees its slot for the next document.
 */
export function itemHoldsWorkerSlot(item: Pick<PlanQueueItem, 'state' | 'landingWaitPaths'>): boolean {
  return itemHoldsWorktree(item.state) && !isLandingWait(item);
}

export function canTransitionItem(from: PlanQueueItemState, to: PlanQueueItemState): boolean {
  if (to === 'parked') {
    return !TERMINAL_STATES.has(from);
  }
  return TRANSITIONS[from].includes(to);
}

export function assertItemTransition(from: PlanQueueItemState, to: PlanQueueItemState): void {
  if (!canTransitionItem(from, to)) {
    throw new Error(`Illegal plan queue item transition: ${from} -> ${to}`);
  }
}

/** A fresh item row; `patch` sets the starting state (and question, if any). */
export function newPlanQueueItem(
  id: string,
  runId: string,
  documentPath: string,
  createdAt: number,
  patch: Partial<PlanQueueItem> = {},
): PlanQueueItem {
  return {
    id,
    runId,
    documentPath,
    state: 'discovered',
    heldAt: null,
    pendingInstruction: null,
    round: 0,
    erroredRounds: 0,
    landingRefusals: 0,
    baseConflicts: 0,
    branchName: null,
    worktreePath: null,
    baseCommit: null,
    checkpointCommit: null,
    verifiedMainCommit: null,
    landedCommit: null,
    workerInstanceId: null,
    verifierInstanceId: null,
    question: null,
    answer: null,
    parkReason: null,
    detail: null,
    verdict: null,
    createdAt,
    updatedAt: createdAt,
    ...patch,
  };
}
