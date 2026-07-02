import type { LoopStage, LoopState } from '../../shared/types/loop.types';
import { resolveContextWindowSize } from '../context/context-window-guard';
import { classifyLoopError } from '../core/loop-error-classification';
import { decideRecoveryRecipe, type RecoveryAttemptRecord } from '../core/loop-recovery-recipes';
import { getLogger } from '../logging/logger';
import { excerpt } from './loop-coordinator-utils';
import { LoopProviderLimitHandler } from './loop-provider-limit-handler';

const logger = getLogger('LoopInvocationErrorRouting');

export type ClassifiedInvocationRoute = 'none' | 'retry-fresh' | 'do-not-retry' | 'parked' | 'terminated';

export function routeClassifiedLoopInvocationFailure(params: {
  state: LoopState;
  error: unknown;
  seq: number;
  stage: LoopStage;
  model?: string;
  contextOverflowRecoveryAttempted: boolean;
  providerLimitHandler: LoopProviderLimitHandler;
  emit: (eventName: string, payload: unknown) => void;
  /** Optional sink for the recovery-recipe audit record so the caller can
   *  attach it to the iteration log. Called at most once per invocation. */
  onRecoveryAttempt?: (record: RecoveryAttemptRecord) => void;
}): ClassifiedInvocationRoute {
  const { state, error, seq, stage } = params;
  const classification = classifyLoopError(error, {
    provider: state.config.provider,
    model: params.model,
  });

  // C3 (#16): consult the named recovery-recipe catalog before the existing
  // branches below. Classifications with no catalog entry are untouched —
  // `decideRecoveryRecipe` returns `kind: 'no-recipe'` and every branch below
  // behaves exactly as it did before this wiring. Catalogued reasons get
  // exactly one automatic attempt per loop run; a repeat within the same run
  // is forced to escalate (`do-not-retry`) instead of retrying again —
  // regardless of whether the underlying classification is otherwise
  // retryable — so recipe-covered errors can't loop forever. This does not
  // replace the `shouldCompress` (context-overflow) branch below, which keeps
  // its own existing single-retry gate (`contextOverflowRecoveryAttempted`);
  // the recipe entry for `context_overflow` only annotates that route for the
  // audit trail (see loop-recovery-recipes.ts).
  const recipeDecision = decideRecoveryRecipe({
    loopRunId: state.id,
    seq,
    reason: classification.reason,
    allowDestructiveOps: state.config.allowDestructiveOps,
  });
  params.onRecoveryAttempt?.(recipeDecision.record);
  if (recipeDecision.kind !== 'no-recipe') {
    logger.info('Recovery recipe consulted for classified invocation failure', {
      loopRunId: state.id,
      seq,
      reason: classification.reason,
      decision: recipeDecision.kind,
      proposedDestructiveSteps: recipeDecision.proposedDestructiveSteps.map(step => step.description),
    });
  }
  if (recipeDecision.kind === 'escalate' && classification.reason !== 'context_overflow') {
    params.emit('loop:activity', {
      loopRunId: state.id,
      seq,
      stage,
      timestamp: Date.now(),
      kind: 'status',
      message: `Recovery recipe for "${classification.reason}" already used its one automatic attempt this run — escalating to BLOCKED`,
      detail: {
        reason: classification.reason,
        proposedDestructiveSteps: recipeDecision.proposedDestructiveSteps.map(step => ({
          description: step.description,
          command: step.command,
        })),
      },
    });
    return 'do-not-retry';
  }

  if (classification.reason === 'rate_limit' && classification.retryAfterMs !== null) {
    const resumeAt = Date.now() + Math.max(0, classification.retryAfterMs);
    const reason =
      `provider invocation classified as rate_limit; parking until server reset ` +
      `(${excerpt(classification.message, 160)})`;
    const outcome = params.providerLimitHandler.handleProviderLimit(state, {
      reason,
      resumeAt,
      source: 'quota',
      action: 'throttle',
      mustStop: true,
    });
    logger.warn('Loop invocation error routed to provider-limit park', {
      loopRunId: state.id,
      seq,
      retryAfterMs: classification.retryAfterMs,
      outcome,
    });
    return outcome === 'parked' ? 'parked' : outcome === 'terminated' ? 'terminated' : 'none';
  }

  if (classification.axes.shouldCompress) {
    if (classification.serverWindowTokens !== undefined) {
      const resolvedWindow = resolveContextWindowSize({
        modelContextWindow: classification.serverWindowTokens,
      });
      const calibratedModel = params.model ?? classification.model;
      state.contextWindowCalibration = {
        provider: state.config.provider,
        ...(calibratedModel ? { model: calibratedModel } : {}),
        windowTokens: resolvedWindow.tokens,
        calibratedAt: Date.now(),
        source: 'provider-error',
        reason: excerpt(classification.message, 240),
      };
    }
    if (params.contextOverflowRecoveryAttempted) return 'do-not-retry';
    params.emit('loop:activity', {
      loopRunId: state.id,
      seq,
      stage,
      timestamp: Date.now(),
      kind: 'status',
      message: 'Context overflow classified — retrying this iteration in a fresh session',
      detail: {
        reason: classification.reason,
        serverWindowTokens: classification.serverWindowTokens,
      },
    });
    logger.warn('Loop invocation context overflow routed to fresh-context retry', {
      loopRunId: state.id,
      seq,
      serverWindowTokens: classification.serverWindowTokens,
    });
    return 'retry-fresh';
  }

  if (!classification.axes.retryable && classification.reason !== 'unknown') {
    logger.warn('Loop invocation error classified as non-retryable; skipping degraded retry', {
      loopRunId: state.id,
      seq,
      reason: classification.reason,
      category: classification.category,
    });
    return 'do-not-retry';
  }

  return 'none';
}
