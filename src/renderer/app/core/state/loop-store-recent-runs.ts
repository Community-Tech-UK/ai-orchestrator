import type { LoopRunSummaryPayload, LoopStatePayload } from '@contracts/schemas/loop';

/**
 * Cap on the renderer's in-memory recent-run list. The bounded read model only
 * needs enough history to recover live/resumable and recently-terminal loop
 * items for the Workboard; the store list request itself caps at 200
 * (`LoopListRunsPayloadSchema`), so the live-event upsert honours the same
 * ceiling to stay consistent.
 */
export const MAX_RECENT_RUNS = 200;

/**
 * Project a live `LoopStatePayload` into the same bounded summary shape the
 * `LOOP_LIST_RUNS` store path returns. Keeping live events and the persisted
 * list in one shape lets the Workboard treat them uniformly. `workspaceCwd`
 * comes straight from the loop config, matching the main-process
 * `rowToRunSummary` derivation. An empty `iterationPrompt` collapses to null,
 * exactly like the persistence layer, so "no distinct continuation" reads the
 * same regardless of whether the summary came from a live event or the store.
 */
export function loopStateToRunSummary(state: LoopStatePayload): LoopRunSummaryPayload {
  const iterationPrompt = state.config.iterationPrompt;
  return {
    id: state.id,
    chatId: state.chatId,
    status: state.status,
    totalIterations: state.totalIterations,
    totalTokens: state.totalTokens,
    totalCostCents: state.totalCostCents,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    endReason: state.endReason ?? null,
    workspaceCwd: state.config.workspaceCwd,
    initialPrompt: state.config.initialPrompt,
    iterationPrompt: iterationPrompt && iterationPrompt.length > 0 ? iterationPrompt : null,
  };
}

/**
 * Upsert a run summary into the recent-run list by run ID (no duplicate IDs),
 * returning a new newest-first array capped at {@link MAX_RECENT_RUNS}. Sorting
 * by `startedAt` descending keeps active and terminal transitions of the same
 * run visible at their existing position rather than jumping to the front on
 * every status change.
 */
export function upsertRecentRun(
  current: readonly LoopRunSummaryPayload[],
  summary: LoopRunSummaryPayload,
): LoopRunSummaryPayload[] {
  const next = current.filter((run) => run.id !== summary.id);
  next.push(summary);
  next.sort((a, b) => b.startedAt - a.startedAt);
  return next.slice(0, MAX_RECENT_RUNS);
}
