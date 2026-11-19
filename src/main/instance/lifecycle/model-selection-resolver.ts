import {
  getDefaultModelForCli,
  isModelTier,
  isDynamicProviderModelId,
  resolveModelReplacementForProvider,
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
  getKnownModels?: (provider: string, copilotAccountProfileId?: string) => Promise<string[]>;
  getDefaultModel?: (provider: string) => string | undefined;
}

export interface ModelSelectionInput {
  provider: CliType;
  copilotAccountProfileId?: string;
  /** Remote workers own their provider defaults and live model catalogues. */
  executionTarget?: 'local' | 'remote';
  configModelOverride?: string | null;
  agentModelOverride?: string | null;
  defaultModelByProvider?: Record<string, string>;
  defaultModel?: string;
  localModelId?: string;
}

export interface ModelCandidateInput {
  provider: CliType;
  configModelOverride?: string | null;
  agentModelOverride?: string | null;
  defaultModelByProvider?: Record<string, string>;
  defaultModel?: string;
}

/**
 * The model a session asks for before any catalogue check: precedence, replacement of retired ids and tier expansion.
 * The spawn path and computer placement both use it, so placement asks the account pool about the same model the
 * session will actually run with.
 */
export function resolveModelCandidate(input: ModelCandidateInput): {
  model: string | undefined;
  source: InitialModelSource;
  tierResolution?: { tier: 'fast' | 'balanced' | 'powerful'; model?: string };
} {
  const resolution = resolveInitialModelWithSource(input);
  const replaced = resolveModelReplacementForProvider(input.provider, resolution.model);
  if (replaced && isModelTier(replaced)) {
    const model = resolveModelForTier(replaced, input.provider);
    return { model, source: resolution.source, tierResolution: { tier: replaced, model } };
  }
  return { model: replaced, source: resolution.source };
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
 * provider-catalog validation, dynamic-model tolerance (Codex, OpenCode), and
 * degradation.
 */
export class ModelSelectionResolver {
  private readonly getKnownModels: NonNullable<ModelSelectionResolverDeps['getKnownModels']>;
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
    const remote = input.executionTarget === 'remote';
    const candidate = resolveModelCandidate({
      provider: input.provider,
      configModelOverride: input.configModelOverride,
      agentModelOverride: input.agentModelOverride,
      // Remembered/global defaults describe the coordinator's provider
      // installation, not the worker's. With no explicit selection the remote
      // provider must choose its own default.
      defaultModelByProvider: remote ? undefined : input.defaultModelByProvider,
      defaultModel: remote ? undefined : input.defaultModel,
    });
    const { model, source: modelSource, tierResolution } = candidate;

    if (!model) {
      return { model: undefined, ...(tierResolution ? { tierResolution } : {}) };
    }

    // A remote worker owns the live model catalogue. Preserve explicit or
    // agent-pinned selections for worker-side validation instead of degrading
    // them against the coordinator's potentially different/stale catalogue.
    if (remote) {
      return tierResolution ? { model, tierResolution } : { model };
    }

    const knownModelIds = input.provider === 'copilot' && input.copilotAccountProfileId
      ? await this.getKnownModels(input.provider, input.copilotAccountProfileId)
      : await this.getKnownModels(input.provider);
    const selection = resolveAvailableModelSelection({
      provider: input.provider,
      requestedModel: model,
      knownModelIds,
      fallbackModel: this.getDefaultModel(input.provider),
      allowDynamicModel: isDynamicProviderModelId(input.provider, model),
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
