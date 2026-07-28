import type {
  AuxiliaryLlmDecision,
  AuxiliaryLlmEndpointConfig,
  AuxiliaryLlmSlot,
} from '../../shared/types/auxiliary-llm.types';
import { getLocalAiAuxiliaryHooks } from '../local-ai-guard/local-ai-auxiliary-bridge';
import { recordAuxiliaryAttribution } from '../core/system/cost-attribution';
import { getTokenCounter } from './token-counter';

export interface LocalAiResolutionContext {
  intendedTargetId?: string;
}

export interface ManagedAuxiliaryTarget {
  targetId: string;
  requiredModelIds: string[];
}

export interface ResolvedAuxiliaryEndpoint {
  endpoint: AuxiliaryLlmEndpointConfig;
  model: string;
  intendedTargetId?: string;
}

const EMPTY_FALLBACK_SLOTS = new Set<AuxiliaryLlmSlot>([
  'compression',
  'memoryDistillation',
  'retrievalHypothesis',
  'verifyOutputSummary',
]);
const JSON_FALLBACK_TEXT =
  '{"score":0,"confidence":0,"reason":"No auxiliary model available"}';

export async function evaluateManagedAuxiliaryEndpoint(
  endpoint: AuxiliaryLlmEndpointConfig,
  slot: AuxiliaryLlmSlot,
  context: LocalAiResolutionContext,
): Promise<ManagedAuxiliaryTarget | undefined | null> {
  if (endpoint.source === 'worker-node' && !endpoint.workerNodeId) return undefined;
  if (endpoint.provider !== 'ollama' && endpoint.provider !== 'openai-compatible') {
    return undefined;
  }
  const target = getLocalAiAuxiliaryHooks().findTarget({
    location: endpoint.source === 'worker-node'
      ? { type: 'worker', nodeId: endpoint.workerNodeId! }
      : { type: 'coordinator' },
    provider: endpoint.provider,
    endpointId: endpoint.id,
    baseUrl: endpoint.baseUrl,
  });
  if (!target) return undefined;
  context.intendedTargetId ??= target.id;
  const verdict = await getLocalAiAuxiliaryHooks().evaluateLocalTarget({
    targetId: target.id,
    slot,
  });
  return verdict.eligible
    ? {
        targetId: target.id,
        requiredModelIds: target.expectedModels
          .filter((model) => model.required)
          .map((model) => model.modelId),
      }
    : null;
}

export function invalidateManagedAuxiliaryTarget(
  target: ManagedAuxiliaryTarget | undefined,
): void {
  if (target) getLocalAiAuxiliaryHooks().invalidateTarget(target.targetId);
}

export function managedAuxiliaryModelsAvailable(
  target: ManagedAuxiliaryTarget | undefined,
  modelIds: readonly string[],
): boolean {
  if (!target) return true;
  const available = modelIds.length > 0
    && target.requiredModelIds.every((required) => modelIds.includes(required));
  if (!available) invalidateManagedAuxiliaryTarget(target);
  return available;
}

export async function runWithLocalAiTargetLease<T>(
  targetId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const release = targetId
    ? getLocalAiAuxiliaryHooks().acquireTarget(targetId)
    : () => undefined;
  try {
    return await run();
  } catch (error) {
    if (targetId) getLocalAiAuxiliaryHooks().invalidateTarget(targetId);
    throw error;
  } finally {
    release();
  }
}

export function requireAuxiliaryText(text: string): string {
  if (!text.trim()) throw new Error('Auxiliary generation returned empty output');
  return text;
}

export async function buildAuthorizedAuxiliaryFallback(input: {
  slot: AuxiliaryLlmSlot;
  reason: string;
  slotAllowsFrontier: boolean;
  systemPrompt: string;
  userPrompt: string;
  intendedTargetId?: string;
  estimatedOutputTokens?: number;
}): Promise<{ text: string; decision: AuxiliaryLlmDecision }> {
  const tokenCounter = getTokenCounter();
  const verdict = await getLocalAiAuxiliaryHooks().authorizeFallback({
    slot: input.slot,
    ...(input.intendedTargetId ? { intendedTargetId: input.intendedTargetId } : {}),
    reason: input.reason,
    estimatedInputTokens:
      tokenCounter.countTokens(input.systemPrompt) + tokenCounter.countTokens(input.userPrompt),
    estimatedOutputTokens: input.estimatedOutputTokens ?? 0,
    slotAllowsFrontier: input.slotAllowsFrontier,
  });
  const allowFrontierFallback = input.slotAllowsFrontier && verdict.allowed;
  const decision: AuxiliaryLlmDecision = {
    slot: input.slot,
    provider: 'local-fallback',
    source: 'fallback',
    reason: input.reason,
    allowFrontierFallback,
    localAiRoutingEventId: verdict.routingEventId,
    ...(input.intendedTargetId ? { intendedTargetId: input.intendedTargetId } : {}),
    fallbackDisposition: verdict.disposition,
  };
  recordAuxiliaryAttribution({
    slot: input.slot,
    provider: 'local-fallback',
    routedTo: 'fallback',
    escalatedToFrontier: allowFrontierFallback,
    reason: input.reason,
  });
  return {
    text: EMPTY_FALLBACK_SLOTS.has(input.slot) ? '' : JSON_FALLBACK_TEXT,
    decision,
  };
}

export function classifyAuxiliarySource(
  endpoint: AuxiliaryLlmEndpointConfig,
  intendedTargetId: string | undefined,
): Exclude<AuxiliaryLlmDecision['source'], 'fallback'> {
  return intendedTargetId
    || endpoint.source === 'localhost'
    || endpoint.source === 'worker-node'
    || endpoint.provider === 'ollama'
    ? 'local'
    : 'cheap-cloud';
}

export function recordSuccessfulAuxiliary(input: {
  slot: AuxiliaryLlmSlot;
  endpoint: AuxiliaryLlmEndpointConfig;
  model: string;
  source: 'local' | 'cheap-cloud';
  systemPrompt: string;
  userPrompt: string;
  text: string;
  reason: string;
}): void {
  const tokenCounter = getTokenCounter();
  recordAuxiliaryAttribution({
    slot: input.slot,
    provider: input.endpoint.provider,
    endpointId: input.endpoint.id,
    model: input.model,
    routedTo: input.source,
    escalatedToFrontier: false,
    usage: {
      inputTokens:
        tokenCounter.countTokens(input.systemPrompt) + tokenCounter.countTokens(input.userPrompt),
      outputTokens: tokenCounter.countTokens(input.text),
    },
    reason: input.reason,
  });
}
