/**
 * Starting a run's item rows: discovery order, document claiming against other
 * active runs, remembered triage decisions (Step 6) and the set-aside offer —
 * a document whose earlier attempt is parked with a branch gets "Resume the
 * set-aside job" instead of a fresh item. A single-path run queues its
 * document directly (deterministic readiness only, no triage session).
 */

import type { PlanQueueItemState, PlanQueueQuestion } from '@contracts/schemas/plan-queue';
import type { PlanQueueHistoryStore } from './plan-queue-history-store';
import type { PlanQueueStore } from './plan-queue-store';
import { isTerminalItemState, newPlanQueueItem } from './plan-queue-state';
import type { RememberedOutcome } from './plan-queue-triage-memory';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import { existsSync } from 'fs';
import { automaticDecisionPatch } from './plan-queue-readiness';
import { buildSortKey } from './plan-queue-sort-key';
import type { WorkCandidate } from './plan-queue-work-source';
import { workSourceForRun } from './plan-queue-work-sources';

export interface PlanQueueRunStartDeps {
  store: PlanQueueStore;
  /** Remembered triage decisions (migration 031). */
  memory?: PlanQueueHistoryStore;
  now: () => number;
  newId: () => string;
}

/** Every step's checklist is ticked, so a job for any of them would have nothing to do. */
const EVERY_STEP_DONE = 'Left out of this run: every step in this plan is already ticked off, so there is nothing left to build. If the work is finished, close the plan; if not, untick what is still to do.';
const NEEDS_PLAN_DETAIL = 'No implementation plan exists. The spec remains open; create and link a plan in a planning task, then queue that plan.';

/**
 * Claim documents and write the run's items in discovery order. Returns the
 * documents already owned by another active run. Must run without awaits
 * between reading the owned set and writing the rows (main-thread atomic).
 */
export function claimDocumentsAndCreateItems(
  deps: PlanQueueRunStartDeps,
  run: PlanQueueRun,
  documents: readonly WorkCandidate[],
  options: { queueDirectly?: boolean } = {},
): string[] {
  const source = workSourceForRun(run);
  const owned = documentsOwnedByActiveRuns(deps.store);
  const excluded = documents.filter((doc) => owned.has(doc.ref)).map((doc) => doc.ref);
  const now = deps.now();
  let order = 0;
  documents.filter((doc) => !owned.has(doc.ref)).forEach((doc) => {
    // createdAt and sortKey carry discovery order: items list in the order they were found.
    // An unplanned spec must stay open: its required planning rename would
    // invalidate this item's path. Implementation belongs to its linked plan.
    const needsPlan = source.awaitsPlan(doc);
    // A plan too big for one job runs one job per step, whether it was picked by name or found; without steps it stays too big.
    const open = needsPlan ? null : source.stepJobs(doc, run);
    const steps = open?.length ? open : null;
    // A set-aside offer is for a whole-document job; a step job is resumed from Set aside.
    const previous = needsPlan || open ? null : deps.store.findLatestParkedItem(doc.ref, run.parentInstanceId);
    const previousRun = previous ? deps.store.getRun(previous.runId) : null;
    // Merged work has moved on from this attempt, so offering to resume it would be an option that always fails.
    const setAside = previous && previousRun?.parentInstanceId === run.parentInstanceId && !deps.store.newerAttemptLanded(previous) ? previous : null;
    const leftOut = open?.length === 0 ? EVERY_STEP_DONE
      : options.queueDirectly || needsPlan || setAside ? null
        : source.leftOutNote(doc, run, deps.store, steps?.[0] ?? null);
    const remembered = !options.queueDirectly && !needsPlan && doc.readiness === 'candidate' && !setAside
      ? source.rememberedOutcome(doc, run, deps.memory)
      : { kind: 'none', detail: '' } as RememberedOutcome;
    const patch = (leftOut ? { state: 'skipped' as PlanQueueItemState, detail: leftOut } : rememberedPatch(remembered))
      ?? (setAside
        ? { state: 'needs-answer' as PlanQueueItemState, detail: null, question: setAsideQuestion(setAside) }
        : needsPlan
          ? { state: 'skipped' as PlanQueueItemState, detail: NEEDS_PLAN_DETAIL }
          : options.queueDirectly && doc.readiness === 'candidate'
            ? { state: 'queued' as PlanQueueItemState, detail: doc.reason ?? null }
            : options.queueDirectly
              ? { state: 'parked' as PlanQueueItemState, parkReason: 'worker-error' as const, detail: doc.reason ?? null }
            : { state: 'discovered' as PlanQueueItemState, detail: doc.reason ?? null });
    // The first step takes the document's readiness decision; later steps wait their turn behind it.
    const laterPatch = patch.state === 'skipped' || patch.state === 'parked' ? patch : { state: 'queued' as PlanQueueItemState, detail: null };
    (steps ?? [null]).forEach((section, position) => {
      const slot = order++;
      deps.store.upsertItem(newPlanQueueItem(deps.newId(), run.id, doc.ref, now + slot, {
        ...(position === 0 ? patch : laterPatch), ...(section === null ? {} : { section }),
        sourceKind: source.kind, sortKey: buildSortKey({ discoveryIndex: slot }),
      }));
    });
  });
  return excluded;
}

/** A remembered decision replaces triage for an unchanged document (Step 6). */
function rememberedPatch(outcome: RememberedOutcome): Partial<PlanQueueItem> | null {
  switch (outcome.kind) {
    case 'none':
      return null;
    case 'ready':
      return { state: 'queued', detail: outcome.detail };
    case 'skip':
      return { state: 'skipped', detail: outcome.detail };
    case 'answered':
      return outcome.optionId === 'skip'
        ? { state: 'skipped', detail: outcome.detail }
        : {
          state: 'queued',
          detail: outcome.detail,
          // The remembered choice reaches the worker in the same shape a live
          // answer takes; the detail line alone only explains the card.
          answer: `${outcome.question} → ${outcome.optionLabel}`,
        };
    case 'ask':
      return automaticDecisionPatch(outcome.question)
        ? { state: 'queued', ...automaticDecisionPatch(outcome.question), detail: outcome.detail }
        : { state: 'needs-answer', detail: outcome.detail, question: outcome.question };
  }
}

export function setAsideQuestion(setAside: PlanQueueItem): PlanQueueQuestion {
  return {
    question: `An earlier attempt at this document is set aside on branch \`${setAside.branchName}\`. What should happen to it?`,
    options: [
      { id: 'resume-set-aside', label: 'Resume the set-aside job' },
      { id: 'fresh', label: 'Start a fresh attempt' },
      { id: 'skip', label: 'Leave this document for now' },
    ],
  };
}

/**
 * A document belongs to one run while any of its jobs is unfinished or holds a folder. A stepped plan's jobs are one group
 * owned by their run, so it stays owned while a later step is still queued behind a step that was set aside.
 */
function documentsOwnedByActiveRuns(store: PlanQueueStore): Set<string> {
  return new Set(
    store.listActiveRuns()
      .flatMap((run) => store.listItems(run.id))
      .filter((item) => !isTerminalItemState(item.state) || (item.worktreePath !== null && existsSync(item.worktreePath)))
      .map((item) => item.sourceRef),
  );
}
