import {
  getDefaultModelForCli,
  isModelTier,
  looksLikeCodexModelId,
  resolveModelForTier,
} from '../../../shared/types/provider.types';
import type { CliType } from '../../cli/cli-detection';
import { getKnownModelsForCli } from './create-validation-helpers';
import {
  resolveAvailableModelSelection,
  type ModelSelectionDegradation,
} from './model-selection-degradation';
import { resolveInitialModel } from './resolve-initial-model';

export interface ModelSelectionResolverDeps {
  getKnownModels?: (provider: string) => Promise<string[]>;
  getDefaultModel?: (provider: string) => string | undefined;
}

export interface ModelSelectionInput {
  provider: CliType;
  configModelOverride?: string | null;
  agentModelOverride?: string | null;
  defaultModelByProvider?: Record<string, string>;
  defaultModel?: string;
  localModelId?: string;
}

export interface ResolvedModelSelection {
  model?: string;
  degradation?: ModelSelectionDegradation;
  knownModelCount?: number;
  tierResolution?: {
    tier: 'fast' | 'balanced' | 'powerful';
    model?: string;
  };
}

/**
 * Owns the complete create-time model decision: precedence, tier expansion,
 * provider-catalog validation, dynamic Codex tolerance, and degradation.
 */
export class ModelSelectionResolver {
  private readonly getKnownModels: (provider: string) => Promise<string[]>;
  private readonly getDefaultModel: (provider: string) => string | undefined;

  constructor(deps: ModelSelectionResolverDeps = {}) {
    this.getKnownModels = deps.getKnownModels ?? getKnownModelsForCli;
    this.getDefaultModel = deps.getDefaultModel ?? getDefaultModelForCli;
  }

  async resolve(input: ModelSelectionInput): Promise<ResolvedModelSelection> {
    if (input.localModelId) {
      return { model: input.localModelId };
    }

    let model = resolveInitialModel({
      configModelOverride: input.configModelOverride,
      agentModelOverride: input.agentModelOverride,
      provider: input.provider,
      defaultModelByProvider: input.defaultModelByProvider,
      defaultModel: input.defaultModel,
    });

    if (!model) {
      return { model: undefined };
    }

    let tierResolution: ResolvedModelSelection['tierResolution'];
    if (isModelTier(model)) {
      const tier = model;
      model = resolveModelForTier(tier, input.provider);
      tierResolution = { tier, model };
    }

    if (!model) {
      return { model: undefined, ...(tierResolution ? { tierResolution } : {}) };
    }

    const knownModelIds = await this.getKnownModels(input.provider);
    const selection = resolveAvailableModelSelection({
      provider: input.provider,
      requestedModel: model,
      knownModelIds,
      fallbackModel: this.getDefaultModel(input.provider),
      allowDynamicCodexModel:
        input.provider === 'codex' && looksLikeCodexModelId(model),
    });

    const result = selection.degradation
      ? {
          model: selection.model,
          degradation: selection.degradation,
          knownModelCount: knownModelIds.length,
        }
      : { model: selection.model };
    return tierResolution ? { ...result, tierResolution } : result;
  }
}
