import { spendProvenanceOf, type LoopSpendByPurpose } from '../../../../shared/types/loop-spend.types';
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
  spendByPurpose?: LoopSpendByPurpose;
  status: string;
  endedAt: number | null;
  totalIterations: number;
  totalCostCents: number;
  endReason?: string | null;
  /** The last completed iteration, for the spend meter's cost provenance. */
  lastIteration?: { costKnown?: boolean; verifyStatus?: string } | null;
  config?: { completion: { verifyCommand?: string; crossModelReview?: { enabled?: boolean } }; caps: { maxIterations?: number | null; maxCostCents?: number | null } };
  pausedForInput?: boolean;
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
    spendProvenance: run.spendByPurpose ? spendProvenanceOf(run.spendByPurpose) : undefined,
    spendIsProviderReported: run.lastIteration?.costKnown === true,
    endReason: run.endReason,
    ...(run.config ? { hasVerifyCommand: Boolean(run.config.completion.verifyCommand?.trim()), hasIndependentReview: run.config.completion.crossModelReview?.enabled === true,
      maxIterations: run.config.caps.maxIterations, maxCostCents: run.config.caps.maxCostCents } : {}),
    pausedForInput: run.pausedForInput,
    verifyStatus: run.lastIteration?.verifyStatus,
  });
}

/** Each advertised recovery has a concrete panel action. */
export function timelineRecoveryTarget(id: string): 'resume' | 'reattempt' | 'inspect' | null {
  if (id === 'resume') return 'resume';
  if (id === 'raise-cap' || id === 'wait-or-switch-provider' || id === 'retry-failed-step') return 'reattempt';
  return id === 'review-now' ? 'inspect' : null;
}
