/**
 * B5 — the loop-control panel's bridge to the causal timeline.
 *
 * Extracted because `loop-control.component.ts` sits against a LOC ratchet and
 * was already over its ceiling before this feature; the derivation and the
 * recovery routing are both self-contained, so they move cleanly.
 */
import { buildLoopCausalTimeline, type LoopTimeline } from './loop-causal-timeline';

/** The subset of a run summary the timeline needs. */
export interface LoopTimelineRun {
  status: string;
  endedAt: number | null;
  totalIterations: number;
  totalCostCents: number;
  endReason?: string | null;
}

export function loopTimelineForRun(run: LoopTimelineRun | undefined | null): LoopTimeline | null {
  if (!run) return null;
  return buildLoopCausalTimeline({
    status: run.status,
    endedAt: run.endedAt,
    iteration: run.totalIterations,
    spentCents: run.totalCostCents,
    endReason: run.endReason,
  });
}

/**
 * Which panel action a recovery button maps to.
 *
 * `wait-or-switch-provider` and `review-now` map to nothing on purpose: neither
 * has a single automatic action, and a button that half-did them would be worse
 * than the sentence explaining what to do.
 */
export function timelineRecoveryTarget(id: string): 'resume' | null {
  return id === 'resume' || id === 'raise-cap' ? 'resume' : null;
}
