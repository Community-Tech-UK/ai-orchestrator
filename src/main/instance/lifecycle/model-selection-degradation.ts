import type { OutputMessage } from '../../../shared/types/instance.types';
import {
  MAX_MODEL_ID_LENGTH,
  resolveModelReplacementForProvider,
} from '../../../shared/types/provider.types';
import { generateId } from '../../../shared/utils/id-generator';

export type ModelSelectionDegradationReason = 'model-unavailable';

export interface ModelSelectionDegradation {
  provider: string;
  requestedModel: string;
  fallbackModel?: string;
  /**
   * `equivalent`: the fallback is the same model family at the same effort
   * level, so the session behaves as the user asked. `default`: nothing
   * matched, so the provider default (or no model) is used instead.
   */
  fallbackKind: 'equivalent' | 'default';
  reason: ModelSelectionDegradationReason;
}

export interface ModelSelectionResolution {
  model?: string;
  degradation?: ModelSelectionDegradation;
}

export function resolveAvailableModelSelection(params: {
  provider: string;
  requestedModel?: string;
  knownModelIds: readonly string[];
  fallbackModel?: string;
  allowDynamicModel?: boolean;
}): ModelSelectionResolution {
  const requestedModel = params.requestedModel?.trim();
  if (!requestedModel) {
    return { model: undefined };
  }

  const fallbackModel = params.fallbackModel?.trim() || undefined;
  if (requestedModel.length > MAX_MODEL_ID_LENGTH) {
    return {
      model: fallbackModel,
      degradation: {
        provider: params.provider,
        requestedModel,
        fallbackModel,
        fallbackKind: 'default',
        reason: 'model-unavailable',
      },
    };
  }

  if (params.knownModelIds.length === 0) {
    return { model: requestedModel };
  }

  if (params.knownModelIds.includes(requestedModel)) {
    return { model: requestedModel };
  }

  if (params.allowDynamicModel) {
    return { model: requestedModel };
  }

  const equivalentModel = findEquivalentModel(params.provider, requestedModel, params.knownModelIds);
  const model = equivalentModel ?? fallbackModel;
  return {
    model,
    degradation: {
      provider: params.provider,
      requestedModel,
      fallbackModel: model,
      fallbackKind: equivalentModel ? 'equivalent' : 'default',
      reason: 'model-unavailable',
    },
  };
}

interface ModelSignature {
  /** Family and variant words in order, e.g. `grok-xhigh` or `claude-opus-thinking-high`. */
  key: string;
  version: number[];
}

/**
 * Split a model id into its family/variant words and its version numbers.
 * A leading word equal to the provider name is a namespace, not part of the
 * family (Cursor lists `cursor-grok-4.6-xhigh` beside `grok-4.7-xhigh`),
 * unless it is the whole family (Grok's own `grok-4.5`).
 * Six-or-more-digit numbers are release dates, not versions, so they are
 * ignored rather than read as a huge version. Ids without a version number
 * (`auto`, `opus[1m]`) have no signature: there is nothing to rank them by.
 */
function modelSignature(provider: string, modelId: string): ModelSignature | undefined {
  const tokens = modelId.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  // Keep the provider word when it is the only family word (`grok-4.5`).
  if (tokens[0] === provider.toLowerCase() && tokens.slice(1).some(token => /[a-z]/.test(token))) tokens.shift();
  const words: string[] = [];
  const version: number[] = [];
  for (const token of tokens) {
    if (/^\d+(\.\d+)*$/.test(token)) {
      if (token.length < 6) version.push(...token.split('.').map(Number));
    } else {
      words.push(token);
    }
  }
  if (version.length === 0 || words.length === 0) return undefined;
  return { key: words.join('-'), version };
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The newest listed model of the same family at the same effort and speed
 * variant as a model the provider no longer offers: `grok-4.5-xhigh` becomes
 * `grok-4.7-xhigh`, never `grok-4.7-xhigh-fast` or `grok-4.7-high`.
 */
export function findEquivalentModel(
  provider: string,
  requestedModel: string,
  knownModelIds: readonly string[],
): string | undefined {
  const requested = modelSignature(provider, requestedModel);
  if (!requested) return undefined;
  let best: { id: string; version: number[] } | undefined;
  for (const id of knownModelIds) {
    const candidate = modelSignature(provider, id);
    if (!candidate || candidate.key !== requested.key) continue;
    if (!best || compareVersions(candidate.version, best.version) > 0) {
      best = { id, version: candidate.version };
    }
  }
  return best?.id;
}

export function createModelSelectionDegradationNotice(
  degradation: ModelSelectionDegradation,
): OutputMessage {
  const fallbackLabel = degradation.fallbackModel
    ? `"${degradation.fallbackModel}"`
    : 'the provider default';
  const using = degradation.fallbackKind === 'equivalent'
    ? `Using ${fallbackLabel}, the closest match it still offers.`
    : `Using ${fallbackLabel} instead.`;

  return {
    id: generateId(),
    timestamp: Date.now(),
    type: 'system',
    content:
      `Model "${degradation.requestedModel}" is no longer available for ${degradation.provider}. `
      + `${using} The saved selection was left unchanged.`,
    metadata: {
      kind: 'model-selection-degraded',
      provider: degradation.provider,
      requestedModel: degradation.requestedModel,
      fallbackModel: degradation.fallbackModel,
      fallbackKind: degradation.fallbackKind,
      reason: degradation.reason,
    },
  };
}

/**
 * Validate a runtime-change model against the target provider's catalog and
 * decide whether the user should hear about a degradation (LT-016).
 *
 * Extracted from `RuntimeReconciler.applyRuntimeChange` so the "is this
 * rejection the user's problem?" rule lives next to the notice it suppresses,
 * and is unit-testable without the reconciler.
 *
 * The rule: the global `defaultModel` is one id shared by every provider, so a
 * swap target routinely rejects it. Nothing the user picked failed, so it is
 * logged but not surfaced. An explicitly requested model — or a stale remembered
 * per-provider one — still is.
 */
export function resolveRuntimeChangeModel(params: {
  provider: string;
  requestedModel: string;
  knownModelIds: readonly string[];
  fallbackModel?: string;
  allowDynamicModel?: boolean;
  modelSource?: string;
}): { model?: string; degradation?: ModelSelectionDegradation; userVisible: boolean } {
  const requestedModel = resolveModelReplacementForProvider(
    params.provider,
    params.requestedModel,
  ) ?? params.requestedModel;
  const selection = resolveAvailableModelSelection({
    provider: params.provider,
    requestedModel,
    knownModelIds: params.knownModelIds,
    fallbackModel: params.fallbackModel,
    allowDynamicModel: params.allowDynamicModel,
  });
  const userVisible = Boolean(selection.degradation) && params.modelSource !== 'global-default';
  return {
    model: selection.model,
    ...(selection.degradation ? { degradation: selection.degradation } : {}),
    userVisible,
  };
}
