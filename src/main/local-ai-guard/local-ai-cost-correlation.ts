import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuxiliaryLlmDecision } from '../../shared/types/auxiliary-llm.types';
import { getLocalAiAuxiliaryHooks } from './local-ai-auxiliary-bridge';

interface LocalAiCostCorrelation {
  routingEventId: string;
  dispatchMark?: Promise<void>;
}

const routingCorrelation = new AsyncLocalStorage<LocalAiCostCorrelation>();

export function withLocalAiCostCorrelation<T>(
  routingEventId: string,
  run: () => Promise<T>,
): Promise<T> {
  return routingCorrelation.run({ routingEventId }, run);
}

export function getLocalAiCostCorrelationId(): string | undefined {
  return routingCorrelation.getStore()?.routingEventId;
}

export async function runCorrelatedPaidFrontierCall<T>(
  run: () => Promise<T>,
): Promise<T> {
  const correlation = routingCorrelation.getStore();
  if (!correlation) return run();
  correlation.dispatchMark ??= Promise.resolve().then(() =>
    getLocalAiAuxiliaryHooks().markFallbackDispatched(correlation.routingEventId)
  );
  await correlation.dispatchMark;
  return run();
}

export async function runAuthorizedFrontierFallback<T>(
  decision: AuxiliaryLlmDecision,
  run: () => Promise<T>,
): Promise<T> {
  if (
    !decision.allowFrontierFallback
    || (decision.fallbackDisposition !== undefined && decision.fallbackDisposition !== 'allowed')
  ) {
    throw new Error('Local AI Guard did not authorize frontier fallback');
  }
  const routingEventId = decision.localAiRoutingEventId;
  if (!routingEventId) {
    return run();
  }
  return withLocalAiCostCorrelation(routingEventId, run);
}
