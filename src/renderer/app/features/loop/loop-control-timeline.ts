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
  /** The last completed iteration, for the spend meter's cost provenance. */
  lastIteration?: { costKnown?: boolean } | null;
}

export function loopTimelineForRun(run: LoopTimelineRun | undefined | null): LoopTimeline | null {
  if (!run) return null;
  return buildLoopCausalTimeline({
    status: run.status,
    endedAt: run.endedAt,
    iteration: run.totalIterations,
    spentCents: run.totalCostCents,
    // Absent provenance reads as an estimate, which is what the meter said
    // before any provider-reported cost was threaded through.
    spendIsProviderReported: run.lastIteration?.costKnown === true,
    endReason: run.endReason,
  });
}

/**
 * Which panel action a recovery button maps to. `null` means there is no
 * single automatic action to route to — `LoopCausalTimelineComponent` renders
 * that recovery as plain text, never a button, so this function is the ONE
 * place that decides both what gets wired AND what the widget can advertise.
 *
 * `wait-or-switch-provider` and `review-now` map to nothing on purpose: neither
 * has a single automatic action, and a button that half-did them would be worse
 * than the sentence explaining what to do.
 */
export function timelineRecoveryTarget(id: string): 'resume' | null {
  return id === 'resume' || id === 'raise-cap' ? 'resume' : null;
}
