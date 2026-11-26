import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AutomationAction } from '../../shared/types/automation.types';
import type { AccountPreferences, InstanceCreateConfig } from '../../shared/types/instance.types';
import { getSettingsManager } from '../core/config/settings-manager';
import { readTestMachines, readUseThisMac } from '../computers/test-machine-file';
import { getWorkerNodeRegistry } from '../remote-node/worker-node-registry';
import { getLogger } from '../logging/logger';
import { resolveNewSessionPlacement } from '../instance/lifecycle/default-computer-placement';
import { readAutomationModelDefaults, resolveAutomationSpawnTarget, type AutomationModelDefaults } from './automation-model-defaults';

const logger = getLogger('AutomationComputerPreference');

function readSettings(): { on: boolean; defaultCli: string | undefined } {
  try {
    const settings = getSettingsManager();
    return { on: settings.get('preferOtherComputers') === true, defaultCli: settings.get('defaultCli') };
  } catch {
    // Settings aren't up (the same case `readAutomationModelDefaults` covers): stay on this Mac.
    return { on: false, defaultCli: undefined };
  }
}

/** True when the folder is, or is inside, a Git repository. */
function insideRepository(folder: string): boolean {
  for (let current = folder; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true;
    if (dirname(current) === current) return false;
  }
}

/**
 * With "Use this Mac when the others are busy or away" off: the computers a plain scheduled job may use (the test Mac,
 * and the PC only once it runs sessions in its Linux side), or why it must stay here. A job in a Git repository stays,
 * because nothing yet sends a repository out for a scheduled job and brings its commits back (that is how queue jobs
 * work); one that only reads, reports or sends messages can go. Undefined when the switch is on or can't be read.
 */
export function automationComputerRule(action: AutomationAction): InstanceCreateConfig['computerRule'] | undefined {
  try {
    if (readUseThisMac()) return undefined;
    if (insideRepository(action.workingDirectory)) {
      return { onlyNodeIds: [], stayHere: "it works in a Git repository, and a scheduled job can't take one to another computer yet" };
    }
    const names = readTestMachines().filter(machine => machine.platform === 'darwin').map(machine => machine.nodeName ?? machine.host);
    if (!names.length) return { onlyNodeIds: [], stayHere: 'no test Mac is set up on the Computers page' };
    const onlyNodeIds = getWorkerNodeRegistry().getHealthyNodes().filter(node => names.includes(node.name)).map(node => node.id);
    return { onlyNodeIds };
  } catch (error) {
    // The settings or the computer list can't be read: behave as the switch being on, as a missing file does.
    logger.warn('Could not read the test machine settings; treating this Mac as switched on', { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

/**
 * Whether a scheduled job's session should ask for a computer that takes agent sessions. Only a plain one-shot job that
 * names no computer: a job with its own execution rules (a contained run, an authority grant), a resume the system
 * sends, or a loop depends on this Mac, so it never asks. It asks when the setting is on, and always when "Use this Mac"
 * is off, because that switch means jobs go to the test Mac.
 */
export function automationPrefersOtherComputer(action: AutomationAction): boolean {
  return !action.forceNodeId && !action.executionAuthority && action.executionProfile !== 'contained'
    && !action.systemAction && !action.loop && (readSettings().on || automationComputerRule(action) !== undefined);
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
      ...computerRuleConfig(action),
    },
    readSettings().defaultCli,
  ).location.type === 'remote';
}

export function computerRuleConfig(action: AutomationAction): Pick<InstanceCreateConfig, 'computerRule'> {
  const computerRule = automationComputerRule(action);
  return computerRule ? { computerRule } : {};
}

/**
 * Why a job must wait before it starts: "Use this Mac" is off and the test Mac, the only computer it may use, is busy,
 * paused or away. Null when it can start (on the test Mac, or here because nothing could ever take it).
 */
export function automationWaitReason(
  action: AutomationAction,
  modelDefaults: AutomationModelDefaults,
  accountPreferences?: AccountPreferences,
): string | null {
  if (!automationPrefersOtherComputer(action)) return null;
  const rule = automationComputerRule(action);
  if (!rule) return null;
  const target = resolveAutomationSpawnTarget(action, modelDefaults);
  const placement = resolveNewSessionPlacement(
    {
      workingDirectory: action.workingDirectory,
      provider: target.provider,
      ...(target.modelOverride ? { modelOverride: target.modelOverride } : {}),
      preferOtherComputer: true,
      accountRouteOrigin: 'automation',
      ...(accountPreferences ? { accountPreferences } : {}),
      computerRule: rule,
    },
    readSettings().defaultCli,
  );
  return placement.mightWaitForComputer ? `Waiting for the test Mac: ${placement.stayedHereBecause}` : null;
}
