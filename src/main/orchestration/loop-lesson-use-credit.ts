/**
 * WS16 — reinforce-on-use crediting for the loop coordinator.
 *
 * At loop termination, lessons that were surfaced into this run's prior-context
 * and are echoed by the run's terminal outcome (the convergence note is the
 * cheapest, always-present signal) get a `reinforceOnUse` bump — the strongest
 * ranking signal (actually used > merely re-observed). Fail-soft: crediting
 * never blocks termination.
 */

import { getLessonStore } from '../memory/lesson-store';
import { detectUsedLessons } from '../memory/retrieval-eval/lesson-use-detector';
import { getRecallTraceStore } from '../memory/retrieval-eval/recall-trace-store';
import { getLogger } from '../logging/logger';

const logger = getLogger('LoopLessonUseCredit');

export function creditSurfacedLessonUse(
  surfaced: readonly { id: string; text: string }[] | undefined,
  outcomeText: string | undefined | null,
): void {
  if (!surfaced || surfaced.length === 0 || !outcomeText?.trim()) return;
  try {
    const usedIds = detectUsedLessons(outcomeText, surfaced);
    if (usedIds.length === 0) return;
    const store = getLessonStore();
    for (const id of usedIds) store.reinforceOnUse(id);
    // Keep recall traces coherent: credit the lessons surface too.
    getRecallTraceStore().markUsed('lessons', usedIds);
    logger.info('Reinforced surfaced lessons on use', { count: usedIds.length });
  } catch (error) {
    logger.warn('Lesson use-crediting failed (skipped)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
