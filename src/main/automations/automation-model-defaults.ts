import { getSettingsManager } from '../core/config/settings-manager';
import {
  resolveAutomationSpawnTarget,
  type AutomationModelDefaults,
  type AutomationSpawnTarget,
} from '../../shared/automations/automation-model-resolution';

// Re-export the pure resolver + its types so existing importers
// (`automation-runner.ts`) keep their import path. The resolution logic lives
// in the shared module so the renderer edit dialog computes display with the
// same function this runner uses.
export {
  resolveAutomationSpawnTarget,
  type AutomationModelDefaults,
  type AutomationSpawnTarget,
};

/**
 * Read the dedicated automation-default model settings plus the mirrored
 * model-picker favourites. Defensive: if the settings manager is not yet
 * available (e.g. in isolated unit tests) or a field is missing, fall back to
 * "no override"/empty favourites so the runner behaves exactly as it did before
 * this feature — the automation's own provider/model still apply.
 */
export function readAutomationModelDefaults(): AutomationModelDefaults {
  try {
    const settings = getSettingsManager().getAll();
    return {
      automationDefaultCli: settings.automationDefaultCli,
      automationDefaultModel: settings.automationDefaultModel,
      modelPickerFavorites: Array.isArray(settings.modelPickerFavorites)
        ? settings.modelPickerFavorites
        : [],
    };
  } catch {
    return {
      automationDefaultCli: 'auto',
      automationDefaultModel: '',
      modelPickerFavorites: [],
    };
  }
}
