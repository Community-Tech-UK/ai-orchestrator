import { resolveCliType } from '../cli/adapters/adapter-factory';
import { getSettingsManager } from '../core/config/settings-manager';
import { getKnownModelsForCli } from '../instance/lifecycle/create-validation-helpers';
import { resolveAvailableModelSelection } from '../instance/lifecycle/model-selection-degradation';
import { resolveInitialModel } from '../instance/lifecycle/resolve-initial-model';
import type { CliType as SettingsCliType } from '../../shared/types/settings.types';
import type { MobileSessionPlan } from '../../shared/types/mobile-gateway.types';
import {
  getDefaultModelForCli,
  getDefaultReasoningEffort,
  getModelShortName,
  isModelTier,
  looksLikeCodexModelId,
  resolveModelForTier,
  type ReasoningEffort,
} from '../../shared/types/provider.types';

/** Providers the phone may ask about; matches the gateway's VALID_PROVIDERS. */
const KNOWN_PROVIDERS = new Set([
  'auto',
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'copilot',
  'cursor',
  'grok',
]);

/** Short, chip-matching provider labels for the phone caption. */
const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  cursor: 'Cursor',
  grok: 'Grok',
  ollama: 'Ollama',
};

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  workflow: 'Workflow',
};

/**
 * Compute what a new mobile session would actually start with. Read-only: it
 * runs the same resolver functions the spawn path uses (see
 * instance-lifecycle.ts `resolveCliType` -> `resolveInitialModel` -> tier
 * resolution -> `resolveAvailableModelSelection`), so the preview matches what
 * would really launch without duplicating the decision logic.
 *
 * The result depends only on the requested provider/model override plus the
 * host's installed CLIs and saved settings — not the working directory — so no
 * directory is needed.
 */
export async function resolveMobileSessionPlan(params: {
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<MobileSessionPlan> {
  const settings = getSettingsManager().getAll();

  const requested =
    params.provider && KNOWN_PROVIDERS.has(params.provider)
      ? (params.provider as SettingsCliType)
      : 'auto';
  const modelOverride = params.model?.trim() || undefined;

  const resolvedProvider = await resolveCliType(requested, settings.defaultCli);

  // Model precedence mirrors the spawn path: explicit override > per-provider
  // remembered > legacy global default. Mobile new-session carries no agent, so
  // there is no agent override to consider.
  let resolvedModel = resolveInitialModel({
    configModelOverride: modelOverride,
    provider: resolvedProvider,
    defaultModelByProvider: settings.defaultModelByProvider,
    defaultModel: settings.defaultModel,
  });

  if (resolvedModel) {
    if (isModelTier(resolvedModel)) {
      resolvedModel = resolveModelForTier(resolvedModel, resolvedProvider);
    }
    if (resolvedModel) {
      const knownModelIds = await getKnownModelsForCli(resolvedProvider);
      const selection = resolveAvailableModelSelection({
        provider: resolvedProvider,
        requestedModel: resolvedModel,
        knownModelIds,
        fallbackModel: getDefaultModelForCli(resolvedProvider),
        allowDynamicCodexModel:
          resolvedProvider === 'codex' && looksLikeCodexModelId(resolvedModel),
      });
      resolvedModel = selection.model;
    }
  }

  const reasoningEffort = params.reasoningEffort ?? getDefaultReasoningEffort(resolvedProvider);

  return {
    provider: resolvedProvider,
    providerLabel: PROVIDER_LABELS[resolvedProvider] ?? resolvedProvider,
    model: resolvedModel ?? null,
    modelLabel: resolvedModel ? getModelShortName(resolvedModel, resolvedProvider) : null,
    reasoningEffort: reasoningEffort ?? null,
    reasoningEffortLabel: reasoningEffort ? EFFORT_LABELS[reasoningEffort] : null,
  };
}
