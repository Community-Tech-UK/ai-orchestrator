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
  preparing: ['working'],
  working: ['awaiting-slot'],
  fixing: ['awaiting-slot'],
  'awaiting-slot': ['verifying', 'fixing'],
  verifying: ['landing', 'fixing', 'awaiting-slot'],
  landing: ['landed', 'fixing'],
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
    round: 0,
    erroredRounds: 0,
    landingRefusals: 0,
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
