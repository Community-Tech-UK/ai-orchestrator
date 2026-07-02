/**
 * F2 (#22) — coordinator-enforced REVIEW→PLAN back-edge.
 *
 * The stage machine is file-driven and the prompt already *instructs* the
 * agent to loop back through PLAN when a review finds issues — but that
 * back-edge is agent-discretionary. This module makes it coordinator-enforced:
 * after a REVIEW-stage iteration, the coordinator derives a structured 3-field
 * veto from the clean-review classification and the fresh-eyes gate outcome:
 *
 *   vetoed = clean === false
 *         || recommendation !== 'APPROVE'
 *         || architecturalStatus !== 'CLEAR'
 *
 * and on any veto FORCES STAGE back to PLAN (agent proposes, coordinator
 * disposes), bounded by a dedicated `completion.maxReviewCycles` cap so review
 * thrash converges. Pure decision logic lives here; the coordinator applies it.
 */
import { getLogger } from '../logging/logger';
import { createLoopPendingInput } from '../../shared/types/loop.types';
import type { LoopConfig, LoopIteration, LoopStage, LoopState } from '../../shared/types/loop.types';
import type { LoopCleanReviewClassification, LoopCleanReviewClassifier } from './loop-clean-review-classifier';
import type { FreshEyesSeverity } from './loop-fresh-eyes-reviewer';

const logger = getLogger('LoopCoordinator');

/** Minimum classifier confidence for a not-clean verdict to count as a veto. */
export const REVIEW_VETO_CONFIDENCE_FLOOR = 0.6;

export interface ReviewBackEdgeFreshEyes {
  /** The fresh-eyes gate ran this iteration (completion was attempted). */
  ran: boolean;
  /** The gate raised at least one blocking finding. */
  blocked: boolean;
  /** Distinct severities among the blocking findings (empty when not blocked). */
  blockingSeverities: readonly FreshEyesSeverity[];
}

export interface ReviewBackEdgeInput {
  /** Stage the iteration ran under. The back-edge only applies to REVIEW. */
  stageBefore: LoopStage;
  /** Stage on disk after the iteration (the agent may have rewritten it). */
  stageAfter: LoopStage;
  /** Clean-review classification of the REVIEW iteration's output, if run. */
  cleanReview: LoopCleanReviewClassification | null;
  /** Fresh-eyes gate outcome for this iteration, if a completion was attempted. */
  freshEyes: ReviewBackEdgeFreshEyes | null;
  /** Forced back-edges already taken this run (`LoopState.reviewCycles`). */
  reviewCycles: number;
  /** `completion.maxReviewCycles` — 0 disables the enforced back-edge. */
  maxReviewCycles: number;
  /** Investigation loops review scope, not code — never force their stage. */
  goalIntent: 'implementation' | 'investigation';
}

export interface ReviewBackEdgeFields {
  clean: boolean;
  recommendation: 'APPROVE' | 'REQUEST_CHANGES';
  architecturalStatus: 'CLEAR' | 'CONCERNS';
}

export interface ReviewBackEdgeDecision {
  /**
   * - `none`: no veto — leave the stage alone.
   * - `rewind`: veto fired and budget remains — force STAGE to PLAN (when
   *   `needsStageWrite`) and increment the cycle counter.
   * - `cap-reached`: veto fired but `maxReviewCycles` is exhausted — do NOT
   *   rewind again; surface a convergence note instead.
   */
  action: 'none' | 'rewind' | 'cap-reached';
  /** The derived 3-field veto, for logging/telemetry. */
  fields: ReviewBackEdgeFields;
  /**
   * True when the agent did not already move the stage to PLAN itself — the
   * coordinator must overwrite STAGE.md. False means count the cycle but
   * respect the agent's own identical write (don't double-drive the file).
   */
  needsStageWrite: boolean;
  reason: string;
}

export function decideReviewBackEdge(input: ReviewBackEdgeInput): ReviewBackEdgeDecision {
  const fields = deriveReviewVetoFields(input);
  const noVeto: ReviewBackEdgeDecision = {
    action: 'none',
    fields,
    needsStageWrite: false,
    reason: 'review output clean; no blocking findings',
  };

  if (input.stageBefore !== 'REVIEW') return { ...noVeto, reason: 'not a REVIEW iteration' };
  if (input.goalIntent === 'investigation') {
    // Investigation REVIEW legitimately narrates remaining work; forcing PLAN
    // would thrash the audit loop.
    return { ...noVeto, reason: 'investigation loop — enforced back-edge does not apply' };
  }
  if (input.maxReviewCycles <= 0) return { ...noVeto, reason: 'enforced back-edge disabled (maxReviewCycles=0)' };

  const vetoed =
    !fields.clean || fields.recommendation !== 'APPROVE' || fields.architecturalStatus !== 'CLEAR';
  if (!vetoed) return noVeto;

  const reason = describeVeto(fields, input);
  if (input.reviewCycles >= input.maxReviewCycles) {
    return { action: 'cap-reached', fields, needsStageWrite: false, reason };
  }
  return {
    action: 'rewind',
    fields,
    needsStageWrite: input.stageAfter !== 'PLAN',
    reason,
  };
}

function deriveReviewVetoFields(input: ReviewBackEdgeInput): ReviewBackEdgeFields {
  // A not-clean classification only vetoes when the classifier is confident —
  // UNCLEAR (confidence 0) must not rewind every ambiguous review output.
  const confidentNotClean =
    input.cleanReview !== null &&
    !input.cleanReview.clean &&
    input.cleanReview.confidence >= REVIEW_VETO_CONFIDENCE_FLOOR;

  const blocked = input.freshEyes?.ran === true && input.freshEyes.blocked;
  const hasCritical = blocked && (input.freshEyes?.blockingSeverities ?? []).includes('critical');

  return {
    clean: !confidentNotClean,
    recommendation: blocked ? 'REQUEST_CHANGES' : 'APPROVE',
    architecturalStatus: hasCritical ? 'CONCERNS' : 'CLEAR',
  };
}

function describeVeto(fields: ReviewBackEdgeFields, input: ReviewBackEdgeInput): string {
  const parts: string[] = [];
  if (!fields.clean) {
    parts.push(`review output not clean (${input.cleanReview?.reason ?? 'unclassified'})`);
  }
  if (fields.recommendation !== 'APPROVE') {
    const severities = (input.freshEyes?.blockingSeverities ?? []).join(', ');
    parts.push(`fresh-eyes review blocked${severities ? ` (${severities})` : ''}`);
  }
  if (fields.architecturalStatus !== 'CLEAR') {
    parts.push('critical-severity finding raised architectural concerns');
  }
  return parts.join('; ') || 'review veto fired';
}

/** Message injected into the next iteration's prompt after a forced rewind. */
export function buildReviewBackEdgeIntervention(decision: ReviewBackEdgeDecision, cycle: number, maxCycles: number): string {
  return (
    `The coordinator vetoed this review and forced STAGE back to PLAN ` +
    `(review cycle ${cycle}/${maxCycles}): ${decision.reason}. ` +
    `Update the plan to address the blocking findings before re-implementing; ` +
    `do not advance STAGE past PLAN until the plan reflects the fixes.`
  );
}

export interface EnforceReviewBackEdgeArgs {
  state: LoopState;
  iteration: LoopIteration;
  stageMachine: {
    readStage(config: LoopConfig): Promise<LoopStage>;
    writeStage(stage: LoopStage): Promise<void>;
  };
  freshEyesGate: {
    ran: boolean;
    blocked: boolean;
    blockingSeverities?: FreshEyesSeverity[];
  } | null;
  seq: number;
  classifyCleanReview: LoopCleanReviewClassifier;
  emit: (eventName: string, payload: unknown) => void;
  setConvergenceNote: (note: string) => void;
}

/**
 * Coordinator action for the enforced back-edge: classifies this REVIEW
 * iteration's output, derives the veto via {@link decideReviewBackEdge}, and
 * applies it — overwriting STAGE.md, bumping `state.reviewCycles`, and queueing
 * the explanatory intervention. Extracted from the coordinator so the logic is
 * testable without the 3.5k-line class.
 */
export async function enforceReviewBackEdgeAction(args: EnforceReviewBackEdgeArgs): Promise<void> {
  const { state, iteration, stageMachine, freshEyesGate, seq, classifyCleanReview, emit, setConvergenceNote } = args;
  const maxReviewCycles = state.config.completion.maxReviewCycles ?? 10;
  if (maxReviewCycles <= 0) return;

  let cleanReview: LoopCleanReviewClassification | null = null;
  try {
    cleanReview = await classifyCleanReview({
      goal: state.config.initialPrompt,
      workspaceCwd: state.config.workspaceCwd,
      iterationOutput: iteration.outputFull || iteration.outputExcerpt,
      config: { noOutstandingPhrase: state.config.completion.noOutstandingPhrase },
    });
  } catch (err) {
    logger.warn('Clean-review classification for the review back-edge failed; skipping veto', {
      loopRunId: state.id,
      seq,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const stageAfter = await stageMachine.readStage(state.config);
  const decision = decideReviewBackEdge({
    stageBefore: 'REVIEW',
    stageAfter,
    cleanReview,
    freshEyes: freshEyesGate
      ? {
          ran: freshEyesGate.ran,
          blocked: freshEyesGate.blocked,
          blockingSeverities: freshEyesGate.blockingSeverities ?? [],
        }
      : null,
    reviewCycles: state.reviewCycles ?? 0,
    maxReviewCycles,
    goalIntent: state.config.goalIntent ?? 'implementation',
  });

  if (decision.action === 'none') return;

  if (decision.action === 'cap-reached') {
    const note = `review back-edge cap reached (${maxReviewCycles} forced rewinds) — ${decision.reason}`;
    setConvergenceNote(note);
    emit('loop:review-back-edge-cap', {
      loopRunId: state.id,
      seq,
      maxReviewCycles,
      fields: decision.fields,
      reason: decision.reason,
    });
    logger.warn('Loop review back-edge cap reached; no further forced rewinds', {
      loopRunId: state.id,
      seq,
      maxReviewCycles,
      reason: decision.reason,
    });
    return;
  }

  // action === 'rewind'
  if (decision.needsStageWrite) {
    try {
      await stageMachine.writeStage('PLAN');
    } catch (err) {
      logger.warn('Failed to write STAGE.md for the review back-edge; leaving stage unchanged', {
        loopRunId: state.id,
        seq,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }
  state.reviewCycles = (state.reviewCycles ?? 0) + 1;
  state.currentStage = 'PLAN';
  state.iterationsOnCurrentStage = 0;
  state.pendingInterventions.push(
    createLoopPendingInput(
      buildReviewBackEdgeIntervention(decision, state.reviewCycles, maxReviewCycles),
    ),
  );
  emit('loop:review-back-edge', {
    loopRunId: state.id,
    seq,
    cycle: state.reviewCycles,
    maxReviewCycles,
    fields: decision.fields,
    reason: decision.reason,
    wroteStage: decision.needsStageWrite,
  });
  logger.info('Loop REVIEW→PLAN back-edge enforced', {
    loopRunId: state.id,
    seq,
    cycle: state.reviewCycles,
    maxReviewCycles,
    wroteStage: decision.needsStageWrite,
    reason: decision.reason,
  });
}
