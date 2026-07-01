import type { LoopStage, LoopState } from '../../shared/types/loop.types';
import { resolveContextWindowSize } from '../context/context-window-guard';
import { classifyLoopError } from '../core/loop-error-classification';
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
}): ClassifiedInvocationRoute {
  const { state, error, seq, stage } = params;
  const classification = classifyLoopError(error, {
    provider: state.config.provider,
    model: params.model,
  });

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
