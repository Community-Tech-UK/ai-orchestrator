/**
 * RTK rollout policy (A13, Steps 18a/18b).
 *
 * One owner for "does the rewrite-only RTK hook run on this spawn", the 50/50
 * trial arm, the coverage table on the Savings tab, and the env block the
 * Claude hook script reads. The eligibility answer is cached only across
 * unchanged settings, so toggling `rtkEnabled` applies to the next new session
 * without a restart.
 *
 * The hook is rewrite-only: it may rewrite a command, never ask and never deny.
 * Auto-approve sessions do not pause for prompts, so an RTK "ask" would stall
 * them; on RTK 0.49+ (RTK_MIN_REWRITE_VERSION) the exit-3 case is "no rule
 * matched, text rewritten", which the hook treats exactly like exit 0.
 */

import * as path from 'path';
import { getLogger } from '../../logging/logger';
import { ensureRtkDeferHookScript } from '../hooks/hook-path-resolver';
import { getSettingsManager } from '../../core/config/settings-manager';
import {
  getRtkRuntime,
  supportsRewriteVersion,
  type RtkRuntimeOptions,
} from './rtk-runtime';

const logger = getLogger('RtkRollout');

export type RtkAutoApproveScope = 'off' | 'trial' | 'on' | 'sessions-only';
export type RtkArm = 'on' | 'off' | 'n/a';
/** Which kind of spawn wants the hook: an interactive session or a loop run. */
export type RtkHookSurface = 'session' | 'loop';

export interface RtkRolloutSettings {
  rtkEnabled: boolean;
  rtkBundledOnly: boolean;
  rtkAutoApproveScope: RtkAutoApproveScope;
}

export interface RtkSpawnConfig {
  enabled: boolean;
  binaryPath: string;
  /** The rewrite-only PreToolUse hook script, only where the scope allows. */
  yoloHookPath?: string;
  /** The trial group this spawn belongs to ('n/a' when the hook is not in play). */
  rtkArm?: RtkArm;
  /** Trial assignment only; never evidence that an on-arm hook ran. */
  rtkTrialEligible?: boolean;
  rtkTrialKey?: string;
}

const adapterRtkConfigs = new WeakMap<object, RtkSpawnConfig>();

/** Preserve the actual config of a persistent loop adapter across settings changes. */
export function rememberRtkAdapterConfig(adapter: unknown, config: RtkSpawnConfig | undefined): void {
  if (adapter && typeof adapter === 'object') {
    if (config) adapterRtkConfigs.set(adapter, config);
    else adapterRtkConfigs.delete(adapter);
  }
}

export function rtkAdapterConfig(adapter: unknown): RtkSpawnConfig | undefined {
  return adapter && typeof adapter === 'object' ? adapterRtkConfigs.get(adapter) : undefined;
}

/** Exposed for tests; production callers use the settings-reading helpers. */
export interface RtkEligibilityInput {
  rtkEnabled: boolean;
  rtkBundledOnly: boolean;
}

interface EligibilityCacheEntry {
  key: string;
  value: boolean;
}

let eligibilityCache: EligibilityCacheEntry | null = null;

/** Test-only: drop the eligibility memo. */
export function _resetRtkRolloutForTesting(): void {
  eligibilityCache = null;
}

/**
 * Whether a usable rewrite-capable rtk exists and the feature is on. Cached by
 * the two settings that decide it — never for the life of the process, so a
 * toggle applies to the next new session (18a item 2).
 */
export function isRtkHookEligible(settings: RtkEligibilityInput, opts?: RtkRuntimeOptions): boolean {
  const key = `${settings.rtkEnabled ? 1 : 0}|${settings.rtkBundledOnly ? 1 : 0}`;
  if (eligibilityCache && eligibilityCache.key === key) {
    return eligibilityCache.value;
  }
  let value = false;
  if (settings.rtkEnabled) {
    const runtime = getRtkRuntime({ ...opts, bundledOnly: settings.rtkBundledOnly });
    value = runtime.isAvailable() && supportsRewriteVersion(runtime.version());
    if (runtime.isAvailable() && !value) {
      logger.warn('rtk binary is below the rewrite-hook floor; hook disabled', {
        version: runtime.version(),
      });
    }
  }
  eligibilityCache = { key, value };
  return value;
}

/** FNV-1a (32-bit) over the key; the low percent decides the arm. */
function armForHash(key: string): boolean {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100 < 50;
}

/**
 * The trial group for a session key (18b item 1): the same `trialKey` Step 1c
 * stamps on spawn options — instance id for interactive sessions, loop run id
 * for loop adapters, correlation id for fresh-child loop calls. Pure and
 * stable, so a session keeps its group across respawns and the grouping can be
 * recomputed offline.
 */
export function rtkArmFor(key: string | undefined, scope: RtkAutoApproveScope): RtkArm {
  if (scope === 'off') return 'off';
  if (scope === 'on' || scope === 'sessions-only') return 'on';
  if (!key) return 'off';
  return armForHash(key) ? 'on' : 'off';
}

/**
 * Whether this spawn gets the rewrite-only hook. `sessions-only` covers
 * interactive sessions and deliberately not loops.
 */
export function shouldUseRtkYoloHook(
  scope: RtkAutoApproveScope,
  surface: RtkHookSurface,
  key?: string,
): boolean {
  if (scope === 'off') return false;
  if (scope === 'sessions-only') return surface === 'session';
  if (scope === 'on') return true;
  return rtkArmFor(key, scope) === 'on';
}

/**
 * The full RTK spawn config for one spawn (18a item 2, 18b items 1 and 4).
 * Returns undefined when RTK is off or the resolved binary is below the
 * rewrite-hook floor, so the caller passes nothing and behaviour equals
 * today's. `rtkArm` is the measured group ('n/a' when this spawn is not part
 * of the measurement).
 */
export function resolveRtkSpawnConfig(
  settings: RtkRolloutSettings,
  surface: RtkHookSurface,
  key?: string,
  opts?: RtkRuntimeOptions,
): RtkSpawnConfig | undefined {
  if (!settings.rtkEnabled) return undefined;
  const runtime = getRtkRuntime({ ...opts, bundledOnly: settings.rtkBundledOnly });
  if (!runtime.isAvailable() || !supportsRewriteVersion(runtime.version())) return undefined;
  const scope = settings.rtkAutoApproveScope;
  const measured = scope === 'off'
    ? false
    : scope === 'sessions-only'
      ? surface === 'session'
      : true;
  const arm: RtkArm = measured ? rtkArmFor(key, scope) : 'n/a';
  let yoloHookPath: string | undefined;
  if (shouldUseRtkYoloHook(scope, surface, key)) {
    try {
      yoloHookPath = ensureRtkDeferHookScript();
    } catch (err) {
      logger.warn('Failed to resolve the RTK rewrite hook script; spawning without it', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    enabled: true,
    binaryPath: runtime.binaryPath(),
    ...(yoloHookPath ? { yoloHookPath } : {}),
    rtkArm: arm,
    ...(scope === 'trial' && key && (arm === 'off' || yoloHookPath)
      ? { rtkTrialEligible: true, rtkTrialKey: key }
      : {}),
  };
}

/**
 * Stamp the trial arm onto the instance so every cost row for this session
 * carries its group (18b item 5). Identity — a respawn of the same instance
 * recomputes the same arm — so repeat stamping is harmless.
 */
export function stampRtkArm<T extends Partial<RtkSpawnConfig> | undefined>(
  instance: { metadata?: Record<string, unknown>; yoloMode?: boolean },
  config: T,
  provider?: string,
  local?: boolean,
): T {
  // Stamp in place: other holders (such as a queue worker's session) keep the same metadata object.
  const metadata = instance.metadata ?? {};
  const eligible = provider === 'claude' && instance.yoloMode === true && local === true
    && config?.enabled === true && !!config.binaryPath && config.rtkTrialEligible === true && !!config.rtkTrialKey
    && (config.rtkArm === 'off' || (config.rtkArm === 'on' && !!config.yoloHookPath));
  const previousKey = metadata['rtkTrialKey'];
  const previousArm = metadata['rtkArm'];
  // Keep the key after an ineligible spawn. A native Claude session can keep
  // its transcript across mode/provider changes, so requalifying later turns
  // would mix ordinary Bash calls into one measured population.
  const stable = previousKey === undefined || (previousKey === config?.rtkTrialKey && previousArm === config?.rtkArm);
  delete metadata['rtkArm'];
  delete metadata['rtkTrialEligible'];
  if (eligible && stable) {
    metadata['rtkArm'] = config?.rtkArm;
    metadata['rtkTrialEligible'] = true;
    metadata['rtkTrialKey'] = config?.rtkTrialKey;
  }
  instance.metadata = metadata;
  return config;
}

/**
 * Loop runs read settings through the existing singleton (18b item 4). A loop
 * gets both trial arms; the off arm carries provenance but no hook. Outside
 * the trial, an unhooked loop gets no config.
 */
export function getAutomationRtk(key?: string): RtkSpawnConfig | undefined {
  const all = getSettingsManager().getAll();
  const scope = all.rtkAutoApproveScope ?? 'off';
  if (scope !== 'trial' && !shouldUseRtkYoloHook(scope, 'loop', key)) return undefined;
  return resolveRtkSpawnConfig({
    rtkEnabled: Boolean(all.rtkEnabled),
    rtkBundledOnly: Boolean(all.rtkBundledOnly),
    rtkAutoApproveScope: scope,
  }, 'loop', key);
}

/**
 * The env block the Claude hook script reads (18b item 3). Belt-and-braces
 * telemetry opt-out rides along; the rewrite-only flag marks auto-approve
 * spawns whose hook must never ask or deny; the log dir gives the hook its
 * per-day coverage log under Harness's own data folder.
 */
export function buildClaudeRtkEnv(options: {
  yoloMode?: boolean;
  rtk?: { enabled: boolean; binaryPath?: string; yoloHookPath?: string } | undefined;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (options.rtk?.enabled && options.rtk.binaryPath) {
    env['ORCHESTRATOR_RTK_ENABLED'] = '1';
    env['ORCHESTRATOR_RTK_PATH'] = options.rtk.binaryPath;
    env['RTK_TELEMETRY_DISABLED'] = '1';
    const logDir = resolveHookLogDir();
    if (logDir) env['ORCHESTRATOR_RTK_LOG_DIR'] = logDir;
    if (options.yoloMode && options.rtk.yoloHookPath) {
      env['ORCHESTRATOR_RTK_REWRITE_ONLY'] = '1';
    }
  }
  return env;
}

/** `<userData>/rtk/hook-decisions`, or undefined outside the packaged app. */
function resolveHookLogDir(): string | undefined {
  try {
    // Lazy so unit tests that import this module never need Electron.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath?(name: string): string } };
    const userData = electron?.app?.getPath?.('userData');
    return userData ? path.join(userData, 'rtk', 'hook-decisions') : undefined;
  } catch {
    return undefined;
  }
}

export interface RtkCoverageRow {
  surface: string;
  mode: 'Hook' | 'Instructions only' | 'Trial' | 'Off';
  note: string;
}

/** The "Where it applies" table on the Savings tab (18a item 4). */
export function describeRtkCoverage(settings: RtkRolloutSettings): RtkCoverageRow[] {
  const eligible = isRtkHookEligible(settings);
  const scope = settings.rtkAutoApproveScope;
  const hook = (on: boolean): RtkCoverageRow['mode'] => (on ? 'Hook' : 'Off');
  const sessionMode: RtkCoverageRow['mode'] = !eligible
    ? 'Off'
    : scope === 'off'
      ? 'Off'
      : scope === 'trial'
        ? 'Trial'
        : 'Hook';
  const loopMode: RtkCoverageRow['mode'] = !eligible
    ? 'Off'
    : scope === 'on'
      ? 'Hook'
      : scope === 'trial'
        ? 'Trial'
        : 'Off';
  return [
    {
      surface: 'Claude asking for approval',
      mode: hook(eligible),
      note: eligible
        ? 'The approval hook also shortens command output.'
        : 'No hook: no usable RTK (Rust Token Killer) copy or the feature is off.',
    },
    {
      surface: 'Claude auto-approve',
      mode: sessionMode,
      note: sessionMode === 'Trial'
        ? 'Half of sessions get the hook, so Harness can measure it.'
        : sessionMode === 'Hook'
          ? 'The hook shortens output without ever asking or denying.'
          : 'Auto-approve sessions never get a hook that can prompt.',
    },
    {
      surface: 'Loops',
      mode: loopMode,
      note: loopMode === 'Trial'
        ? 'Half of loop runs get the hook, so Harness can measure it.'
        : loopMode === 'Hook'
          ? 'Every loop run gets the rewrite-only hook.'
          : 'Loop runs stay unhooked for now.',
    },
    {
      surface: 'Codex',
      mode: settings.rtkEnabled ? 'Instructions only' : 'Off',
      note: 'Codex is asked to run commands through RTK in the shell tool.',
    },
    {
      surface: 'Copilot, Cursor, OpenCode, Grok',
      mode: settings.rtkEnabled ? 'Instructions only' : 'Off',
      note: 'Same instruction text; no hook is installed for these CLIs.',
    },
    {
      surface: 'Antigravity and Gemini',
      mode: settings.rtkEnabled ? 'Instructions only' : 'Off',
      note: 'Same instruction text; no hook is installed for these CLIs.',
    },
    {
      surface: 'Remote machines',
      mode: 'Off',
      note: 'Worker-machine sessions run their own CLIs; nothing is forwarded yet.',
    },
  ];
}
