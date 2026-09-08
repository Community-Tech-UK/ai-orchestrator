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
  /**
   * Why each candidate endpoint was passed over, in the order they were tried.
   *
   * Endpoint resolution used to discard this entirely: every distinct failure —
   * an ineligible health verdict, a model-inventory probe that timed out, a
   * target with no candidate endpoints at all — collapsed into the single string
   * "No healthy auxiliary endpoint/model available", which is not actionable and
   * is not persisted anywhere. On 2026-09-07 that hid 94% of all auxiliary
   * routing decisions falling back, with no way to tell which gate closed.
   * Bounded so a long endpoint list cannot grow this without limit.
   */
  ineligibleReasons?: string[];
}

/** Cap on {@link LocalAiResolutionContext.ineligibleReasons}. */
const MAX_INELIGIBLE_REASONS = 8;

/** Record why a candidate endpoint could not be used. */
export function recordAuxiliaryIneligibility(
  context: LocalAiResolutionContext,
  endpointId: string,
  reason: string,
): void {
  context.ineligibleReasons ??= [];
  if (context.ineligibleReasons.length >= MAX_INELIGIBLE_REASONS) return;
  context.ineligibleReasons.push(`${endpointId}: ${reason}`);
}

/**
 * Render the collected reasons into the fallback's `reason` string, so the
 * decision that reaches cost attribution and the caller says what actually
 * happened rather than only that something did.
 */
export function describeAuxiliaryResolutionFailure(
  context: LocalAiResolutionContext,
): string {
  const reasons = context.ineligibleReasons ?? [];
  if (reasons.length === 0) {
    return 'No auxiliary endpoint was even a candidate (none configured, discovered, or enabled)';
  }
  return `No healthy auxiliary endpoint/model available — ${reasons.join('; ')}`;
}

export interface ManagedAuxiliaryTarget {
  targetId: string;
  requiredModelIds: string[];
}

export interface ResolvedAuxiliaryEndpoint {
  endpoint: AuxiliaryLlmEndpointConfig;
  model: string;
  intendedTargetId?: string;
  /** True when `model` came from the tier auto-pick rather than an explicit or tier pin. */
  autoPicked?: boolean;
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
  if (!verdict.eligible) {
    recordAuxiliaryIneligibility(context, endpoint.id, verdict.reason);
    return null;
  }
  return {
    targetId: target.id,
    requiredModelIds: target.expectedModels
      .filter((model) => model.required)
      .map((model) => model.modelId),
  };
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
