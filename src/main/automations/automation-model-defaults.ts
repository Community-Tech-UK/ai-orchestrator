import type { AutomationAction } from '../../shared/types/automation.types';
import type { InstanceProvider } from '../../shared/types/instance.types';
import type { CliType } from '../../shared/types/settings.types';
import { getSettingsManager } from '../core/config/settings-manager';

/**
 * The dedicated automation-default settings that back an automation whose Model
 * is left on **Auto**. Kept separate from `defaultCli`/`defaultModelByProvider`
 * because those are rewritten by interactive picker usage; these are not.
 */
export interface AutomationModelDefaults {
  automationDefaultCli: CliType;
  automationDefaultModel: string;
}

export interface AutomationSpawnTarget {
  provider: InstanceProvider | undefined;
  modelOverride: string | undefined;
}

/**
 * Read the dedicated automation-default model settings. Defensive: if the
 * settings manager is not yet available (e.g. in isolated unit tests), fall
 * back to "no override" so the runner behaves exactly as it did before this
 * feature — the automation's own provider/model still apply.
 */
export function readAutomationModelDefaults(): AutomationModelDefaults {
  try {
    const settings = getSettingsManager().getAll();
    return {
      automationDefaultCli: settings.automationDefaultCli,
      automationDefaultModel: settings.automationDefaultModel,
    };
  } catch {
    return { automationDefaultCli: 'auto', automationDefaultModel: '' };
  }
}

/** Legacy persisted `'openai'` maps to the canonical `'codex'` provider. */
function normalizeProvider(provider: CliType): InstanceProvider {
  return provider === 'openai' ? 'codex' : provider;
}

/**
 * Resolve the provider + model an automation run should spawn with.
 *
 * A model/provider pinned on the automation itself always wins. Only where the
 * automation left the field on Auto do we substitute the dedicated automation
 * default, which is a stable value the interactive picker never clobbers. When
 * neither the automation nor the default supplies a value, the fields fall
 * through unchanged so the normal provider/model resolution takes over — i.e.
 * an empty default is fully backwards compatible.
 */
export function resolveAutomationSpawnTarget(
  action: Pick<AutomationAction, 'provider' | 'model'>,
  defaults: AutomationModelDefaults,
): AutomationSpawnTarget {
  const pinnedModel = action.model?.trim() ? action.model : undefined;
  const pinnedProvider =
    action.provider && action.provider !== 'auto' ? action.provider : undefined;

  const defaultModel = defaults.automationDefaultModel?.trim()
    ? defaults.automationDefaultModel
    : undefined;
  const defaultProvider =
    defaults.automationDefaultCli && defaults.automationDefaultCli !== 'auto'
      ? normalizeProvider(defaults.automationDefaultCli)
      : undefined;

  return {
    provider: pinnedProvider ?? defaultProvider ?? action.provider,
    modelOverride: pinnedModel ?? defaultModel,
  };
}
