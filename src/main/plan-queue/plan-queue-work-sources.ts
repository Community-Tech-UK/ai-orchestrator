/**
 * Which work source an item or run belongs to. Lazy on purpose: the sources import the modules that call this, and
 * reading them when this file loads would make an import cycle fail.
 */

import type { PlanQueueSourceKind } from '@contracts/schemas/plan-queue';
import { markdownWorkSource } from './plan-queue-markdown-source';
import type { QueueWorkSource } from './plan-queue-work-source';

/** `undefined` is an item row or test fixture written before sources existed: markdown. */
export function workSourceFor(kind: PlanQueueSourceKind | undefined): QueueWorkSource {
  switch (kind ?? 'markdown') {
    case 'markdown': return markdownWorkSource;
    case 'linear': throw new Error('The Linear work source is not built yet.');
  }
}

/** The source a run takes its work from. Plan and livetest runs are both markdown. A tickets run has no source until the Linear source is built (Step 3). */
export function workSourceForRun(run: { kind: string }): QueueWorkSource {
  if (run.kind === 'tickets') throw new Error('The Linear work source is not built yet.');
  return markdownWorkSource;
}

/** Every source the app has; boot recovery asks each to finish what an earlier run of the app left half done. */
export function allWorkSources(): readonly QueueWorkSource[] {
  return [markdownWorkSource];
}
