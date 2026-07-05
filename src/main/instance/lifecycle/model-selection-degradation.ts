import type { OutputMessage } from '../../../shared/types/instance.types';
import { MAX_MODEL_ID_LENGTH } from '../../../shared/types/provider.types';
import { generateId } from '../../../shared/utils/id-generator';

export type ModelSelectionDegradationReason = 'model-unavailable';

export interface ModelSelectionDegradation {
  provider: string;
  requestedModel: string;
  fallbackModel?: string;
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
  allowDynamicCodexModel?: boolean;
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

  if (params.allowDynamicCodexModel) {
    return { model: requestedModel };
  }

  return {
    model: fallbackModel,
    degradation: {
      provider: params.provider,
      requestedModel,
      fallbackModel,
      reason: 'model-unavailable',
    },
  };
}

export function createModelSelectionDegradationNotice(
  degradation: ModelSelectionDegradation,
): OutputMessage {
  const fallbackLabel = degradation.fallbackModel
    ? `"${degradation.fallbackModel}"`
    : 'the provider default';

  return {
    id: generateId(),
    timestamp: Date.now(),
    type: 'system',
    content:
      `Model "${degradation.requestedModel}" is no longer available for ${degradation.provider}. `
      + `Using ${fallbackLabel} instead. The saved selection was left unchanged.`,
    metadata: {
      kind: 'model-selection-degraded',
      provider: degradation.provider,
      requestedModel: degradation.requestedModel,
      fallbackModel: degradation.fallbackModel,
      reason: degradation.reason,
    },
  };
}
