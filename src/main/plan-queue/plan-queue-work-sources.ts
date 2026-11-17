/**
 * Which work source an item or run belongs to. Lazy on purpose: the sources import the modules that call this, and
 * reading them when this file loads would make an import cycle fail.
 */

import type { PlanQueueSourceKind } from '@contracts/schemas/plan-queue';
import { linearWorkSource } from './plan-queue-linear-source';
import { markdownWorkSource } from './plan-queue-markdown-source';
import type { QueueWorkSource } from './plan-queue-work-source';

/** `undefined` is an item row or test fixture written before sources existed: markdown. */
export function workSourceFor(kind: PlanQueueSourceKind | undefined): QueueWorkSource {
  switch (kind ?? 'markdown') {
    case 'markdown': return markdownWorkSource;
    case 'linear': return linearWorkSource;
  }
}

/** The source a run takes its work from. Plan and livetest runs are markdown; a tickets run is Linear. */
export function workSourceForRun(run: { kind: string }): QueueWorkSource {
  return run.kind === 'tickets' ? linearWorkSource : markdownWorkSource;
}

/** Every source the app has; boot recovery asks each to finish what an earlier run of the app left half done. */
export function allWorkSources(): readonly QueueWorkSource[] {
  return [markdownWorkSource, linearWorkSource];
}
