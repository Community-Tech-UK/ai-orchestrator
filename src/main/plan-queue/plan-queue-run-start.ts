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
import { rememberedOutcomeForPath, type RememberedOutcome } from './plan-queue-triage-memory';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import { existsSync } from 'fs';
import { automaticDecisionPatch } from './plan-queue-readiness';

export interface DiscoveredPlanQueueDocument {
  path: string;
  readiness: 'candidate' | 'not-ready';
  reason?: string | null;
}

export interface PlanQueueRunStartDeps {
  store: PlanQueueStore;
  /** Remembered triage decisions (migration 031). */
  memory?: PlanQueueHistoryStore;
  now: () => number;
  newId: () => string;
}

const NEEDS_PLAN_DETAIL = 'No implementation plan exists. The spec remains open; create and link a plan in a planning task, then queue that plan.';

/**
 * Claim documents and write the run's items in discovery order. Returns the
 * documents already owned by another active run. Must run without awaits
 * between reading the owned set and writing the rows (main-thread atomic).
 */
export function claimDocumentsAndCreateItems(
  deps: PlanQueueRunStartDeps,
  run: PlanQueueRun,
  documents: readonly DiscoveredPlanQueueDocument[],
  options: { queueDirectly?: boolean } = {},
): string[] {
  const owned = documentsOwnedByActiveRuns(deps.store);
  const excluded = documents.filter((doc) => owned.has(doc.path)).map((doc) => doc.path);
  const now = deps.now();
  documents.filter((doc) => !owned.has(doc.path)).forEach((doc, index) => {
    // createdAt carries discovery order: items list in the order they were found.
    // An unplanned spec must stay open: its required planning rename would
    // invalidate this item's path. Implementation belongs to its linked plan.
    const needsPlan = doc.readiness === 'not-ready' && doc.path.toLowerCase().endsWith('_spec.md');
    const previous = needsPlan ? null : deps.store.findLatestParkedItem(doc.path, run.parentInstanceId);
    const previousRun = previous ? deps.store.getRun(previous.runId) : null;
    const setAside = previousRun?.parentInstanceId === run.parentInstanceId ? previous : null;
    const remembered = !options.queueDirectly && !needsPlan && doc.readiness === 'candidate' && !setAside
      ? rememberedOutcomeForPath(deps.memory, doc.path, run.workspaceCwd)
      : { kind: 'none', detail: '' } as RememberedOutcome;
    const patch = rememberedPatch(remembered)
      ?? (setAside
        ? { state: 'needs-answer' as PlanQueueItemState, detail: null, question: setAsideQuestion(setAside) }
        : needsPlan
          ? { state: 'skipped' as PlanQueueItemState, detail: NEEDS_PLAN_DETAIL }
          : options.queueDirectly && doc.readiness === 'candidate'
            ? { state: 'queued' as PlanQueueItemState, detail: doc.reason ?? null }
            : options.queueDirectly
              ? { state: 'parked' as PlanQueueItemState, parkReason: 'worker-error' as const, detail: doc.reason ?? null }
            : { state: 'discovered' as PlanQueueItemState, detail: doc.reason ?? null });
    deps.store.upsertItem(newPlanQueueItem(deps.newId(), run.id, doc.path, now + index, patch));
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

function documentsOwnedByActiveRuns(store: PlanQueueStore): Set<string> {
  return new Set(
    store.listActiveRuns()
      .flatMap((run) => store.listItems(run.id))
      .filter((item) => !isTerminalItemState(item.state) || (item.worktreePath !== null && existsSync(item.worktreePath)))
      .map((item) => item.documentPath),
  );
}
