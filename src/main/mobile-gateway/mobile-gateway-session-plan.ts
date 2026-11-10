import { providerName } from '../../shared/display-names';
import { resolveCliType } from '../cli/adapters/adapter-factory';
import { getSettingsManager } from '../core/config/settings-manager';
import { getKnownModelsForCli } from '../instance/lifecycle/create-validation-helpers';
import { resolveAvailableModelSelection } from '../instance/lifecycle/model-selection-degradation';
import { resolveInitialModel } from '../instance/lifecycle/resolve-initial-model';
import { getProviderAccountRoutingService } from '../providers/account-pool/provider-account-routing-service';
import { getProviderAccountStore } from '../providers/account-pool/provider-account-store';
import type { CliType as SettingsCliType } from '../../shared/types/settings.types';
import type { MobileSessionAccountPlan, MobileSessionPlan } from '../../shared/types/mobile-gateway.types';
import {
  isLogicalMiMoModel,
  isPooledProvider,
  type AccountRouteSource,
} from '../../shared/types/provider-account.types';
import {
  getDefaultModelForCli,
  getDefaultReasoningEffort,
  getModelShortName,
  isModelTier,
  isDynamicProviderModelId,
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
  'opencode',
]);

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
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
  /** The account the person picked; one that is no longer offered is ignored. */
  accountProfileId?: string;
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
        allowDynamicModel: isDynamicProviderModelId(resolvedProvider, resolvedModel),
      });
      resolvedModel = selection.model;
    }
  }

  const reasoningEffort = params.reasoningEffort ?? getDefaultReasoningEffort(resolvedProvider, resolvedModel);
  const account = await resolveMobileAccountPlan(resolvedProvider, resolvedModel ?? null, params.accountProfileId);

  return {
    provider: resolvedProvider,
    // Short, chip-matching provider name for the phone caption. OpenCode reads
    // "MiMo" only when the resolved model is a MiMo Token Plan model.
    providerLabel: providerName(resolvedProvider, { model: resolvedModel }),
    model: resolvedModel ?? null,
    modelLabel: resolvedModel ? getModelShortName(resolvedModel, resolvedProvider) : null,
    reasoningEffort: reasoningEffort ?? null,
    reasoningEffortLabel: reasoningEffort ? EFFORT_LABELS[reasoningEffort] : null,
    ...(account ? { account } : {}),
  };
}

const ROUTE_REASONS: Record<AccountRouteSource, string> = {
  explicit: 'you chose this account',
  default: 'chosen automatically',
  failover: 'moved here at a usage limit',
  preemptive: 'moved here before a usage limit',
  persisted: 'the account this conversation runs on',
  legacy: 'your existing sign-in',
};

/**
 * The accounts a new session may be started on, matching the desktop composer's
 * account chip: accounts that are turned on and not barred from use, in the
 * host's priority order, plus the account the pool would pick and why. Null
 * when the provider has no pool or fewer than two accounts can be chosen.
 * OpenCode accounts only apply to MiMo models, as at spawn.
 */
async function resolveMobileAccountPlan(
  provider: string,
  model: string | null,
  chosenId: string | undefined,
): Promise<MobileSessionAccountPlan | null> {
  if (!isPooledProvider(provider)) return null;
  if (provider === 'opencode' && !isLogicalMiMoModel(model)) return null;
  const profiles = getProviderAccountStore().listProfiles(provider)
    .filter((profile) => profile.enabled && profile.automationPolicy !== 'disabled')
    .sort((a, b) => a.priority - b.priority);
  if (profiles.length < 2) return null;

  const labelFor = (id: string) => profiles.find((profile) => profile.id === id)?.label ?? id;
  const explicitProfileId = chosenId && profiles.some((profile) => profile.id === chosenId) ? chosenId : undefined;
  const preview = await getProviderAccountRoutingService().preview({
    provider,
    model,
    ...(explicitProfileId ? { explicitProfileId } : {}),
    origin: 'interactive',
  });
  const options = profiles.map((profile) => ({ id: profile.id, label: profile.label }));
  if (!preview.outcome.ok) {
    return { options, summary: preview.outcome.detail };
  }
  const route = preview.outcome.route;
  const skipped = preview.considered.find((entry) => entry.vetoReason === 'parked' || entry.vetoReason === 'exhausted');
  const reason = skipped && route.source === 'default'
    ? `${labelFor(skipped.profileId)} is at its limit`
    : ROUTE_REASONS[route.source];
  return { options, summary: `${route.profileLabel ?? labelFor(route.profileId)} · ${reason}` };
}
