import type { AutomationAction } from '../../shared/types/automation.types';
import type { AccountPreferences } from '../../shared/types/instance.types';
import { getSettingsManager } from '../core/config/settings-manager';
import { resolveNewSessionPlacement } from '../instance/lifecycle/default-computer-placement';
import { readAutomationModelDefaults, resolveAutomationSpawnTarget, type AutomationModelDefaults } from './automation-model-defaults';

function readSettings(): { on: boolean; defaultCli: string | undefined } {
  try {
    const settings = getSettingsManager();
    return { on: settings.get('preferOtherComputers') === true, defaultCli: settings.get('defaultCli') };
  } catch {
    // Settings aren't up (the same case `readAutomationModelDefaults` covers): stay on this Mac.
    return { on: false, defaultCli: undefined };
  }
}

/**
 * Whether a scheduled job's session should ask for a computer that takes agent sessions. Only a plain one-shot job that
 * names no computer: a job with its own execution rules (a contained run, an authority grant), a resume the system
 * sends, or a loop depends on this Mac, so it never asks.
 */
export function automationPrefersOtherComputer(action: AutomationAction): boolean {
  return !action.forceNodeId && !action.executionAuthority && action.executionProfile !== 'contained'
    && !action.systemAction && !action.loop && readSettings().on;
}

/**
 * Whether a job will run on another computer if it starts now: it names one, or it asks and one can run it. Admission
 * uses this to skip this Mac's load check for work that won't run here. The placement is decided again when the
 * session is created, so a computer that fills up in between sends the job here after all.
 *
 * `accountPreferences` are the run's never-use and use-last lists (see `automationAccountPreferences`). The check that
 * really holds a run back passes them, so the account it reads is the one the run is created with; a caller without
 * them (a display or queue-order read) gets a close read, not the final placement.
 */
export function automationRunsOnOtherComputer(
  action: AutomationAction,
  modelDefaults: AutomationModelDefaults = readAutomationModelDefaults(),
  accountPreferences?: AccountPreferences,
): boolean {
  if (action.forceNodeId) return true;
  if (!automationPrefersOtherComputer(action)) return false;
  const target = resolveAutomationSpawnTarget(action, modelDefaults);
  return resolveNewSessionPlacement(
    {
      workingDirectory: action.workingDirectory,
      provider: target.provider,
      ...(target.modelOverride ? { modelOverride: target.modelOverride } : {}),
      preferOtherComputer: true,
      accountRouteOrigin: 'automation',
      ...(accountPreferences ? { accountPreferences } : {}),
    },
    readSettings().defaultCli,
  ).location.type === 'remote';
}
