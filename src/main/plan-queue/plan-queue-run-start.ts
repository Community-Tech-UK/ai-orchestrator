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
import { existsSync, readFileSync, statSync } from 'fs';
import { repeatedStopNote } from './plan-queue-document-memory';
import { automaticDecisionPatch } from './plan-queue-readiness';
import { stepsToRun } from './plan-queue-sections';

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

/** One worker rarely finishes more than this in a job (step 5.1); revisit with Queue health's numbers. */
const OVERSIZED_BYTES = 50_000;
const OVERSIZED_OPEN_ITEMS = 20;

/** Why a bulk start leaves a plan out as too big for one job, or null. Picking it by name still starts it. */
export function oversizedNote(documentPath: string): string | null {
  let size: number;
  try { size = statSync(documentPath).size; } catch { return null; }
  const kilobytes = Math.round(size / 1000);
  // Too big already: no need to read it, and this runs on the main thread.
  if (size > OVERSIZED_BYTES) return `Left out of this run: at ${kilobytes} KB it is likely too big for one job. Split it, or pick it by name to start it anyway.`;
  let open: number;
  try { open = readFileSync(documentPath, 'utf8').match(/^\s*[-*] \[ \]/gm)?.length ?? 0; } catch { return null; }
  if (open <= OVERSIZED_OPEN_ITEMS) return null;
  return `Left out of this run: with ${open} unticked items it is likely too big for one job. Split it, or pick it by name to start it anyway.`;
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
  documents: readonly DiscoveredPlanQueueDocument[],
  options: { queueDirectly?: boolean } = {},
): string[] {
  const owned = documentsOwnedByActiveRuns(deps.store);
  const excluded = documents.filter((doc) => owned.has(doc.path)).map((doc) => doc.path);
  const now = deps.now();
  let order = 0;
  documents.filter((doc) => !owned.has(doc.path)).forEach((doc) => {
    // createdAt carries discovery order: items list in the order they were found.
    // An unplanned spec must stay open: its required planning rename would
    // invalidate this item's path. Implementation belongs to its linked plan.
    const needsPlan = doc.readiness === 'not-ready' && doc.path.toLowerCase().endsWith('_spec.md');
    // A plan too big for one job runs one job per step, whether it was picked by name or found; without steps it stays too big.
    const tooBig = needsPlan || run.kind !== 'plans' ? null : oversizedNote(doc.path);
    const open = tooBig ? stepsToRun(doc.path) : null;
    const steps = open?.length ? open : null;
    // A set-aside offer is for a whole-document job; a step job is resumed from Set aside.
    const previous = needsPlan || open ? null : deps.store.findLatestParkedItem(doc.path, run.parentInstanceId);
    const previousRun = previous ? deps.store.getRun(previous.runId) : null;
    // Merged work has moved on from this attempt, so offering to resume it would be an option that always fails.
    const setAside = previous && previousRun?.parentInstanceId === run.parentInstanceId && !deps.store.newerAttemptLanded(previous) ? previous : null;
    const leftOut = open?.length === 0 ? EVERY_STEP_DONE
      : options.queueDirectly || needsPlan || setAside ? null
        : (steps ? null : tooBig) ?? repeatedStopNote(deps.store, doc.path, steps?.[0]);
    const remembered = !options.queueDirectly && !needsPlan && doc.readiness === 'candidate' && !setAside
      ? rememberedOutcomeForPath(deps.memory, doc.path, run.workspaceCwd)
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
      deps.store.upsertItem(newPlanQueueItem(deps.newId(), run.id, doc.path, now + order++, { ...(position === 0 ? patch : laterPatch), ...(section === null ? {} : { section }) }));
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
      .map((item) => item.documentPath),
  );
}
