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
import { resolveInitialModelWithSource, type InitialModelSource } from './resolve-initial-model';

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

/**
 * Where the model being validated came from (LT-016). A rejection only deserves
 * a user-facing notice when the user actually chose the thing that was
 * rejected — the provider-agnostic global `defaultModel` is not a choice they
 * made for *this* provider.
 */
export interface ResolvedModelSelection {
  model?: string;
  degradation?: ModelSelectionDegradation;
  /**
   * Which precedence rung supplied the model. Note this describes the model as
   * *resolved*, before tier expansion — if a tier was expanded,
   * `degradation.requestedModel` is the expanded provider-native id while this
   * still names where the tier came from.
   */
  modelSource?: InitialModelSource;
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

    // Decision and provenance come from ONE call — see the note on
    // `resolveInitialModelWithSource` for why they must not be computed apart.
    const resolution = resolveInitialModelWithSource({
      configModelOverride: input.configModelOverride,
      agentModelOverride: input.agentModelOverride,
      provider: input.provider,
      defaultModelByProvider: input.defaultModelByProvider,
      defaultModel: input.defaultModel,
    });
    let model = resolution.model;
    const modelSource: InitialModelSource = resolution.source;

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
          modelSource,
          knownModelCount: knownModelIds.length,
        }
      : { model: selection.model };
    return tierResolution ? { ...result, tierResolution } : result;
  }
}
