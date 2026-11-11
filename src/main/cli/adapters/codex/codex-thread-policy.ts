import { createHash } from 'node:crypto';
import type { SessionKind } from '../../../../shared/types/session-kind.types';
import type { TrialKeySource } from '../../../../shared/utils/machine-session';
import type { CodexCliConfig } from '../codex-adapter-config';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { getSettingsManager } from '../../../core/config/settings-manager';
import { getLogger } from '../../../logging/logger';
import { errorDiagnostic } from '../../../logging/source-diagnostics';

const logger = getLogger('CodexThreadPolicy');
export type CodexTrialArm = 'cheaper' | 'full' | 'off' | 'unassigned';
export type CodexChatsSetting = 'economy' | 'full' | 'off' | 'trial';
export type CodexHarnessWorkSetting = 'off' | 'full' | 'trial';
export type CodexTuningSetting = 'harness' | 'codex';
/** Which skills catalog a thread gets: Codex's own (chats), the 1,500-token cap, or none (checker trial). */
export type CodexSkillCatalog = 'native' | 'capped' | 'omitted';
export type CodexCheckerCatalogSetting = 'trial' | 'full' | 'omit';
export type CodexCheckerArm = 'control' | 'candidate' | 'unassigned';
/** The checker catalog trial has its own salt, so its half-and-half split is independent of the helper-agent trial. */
export const CHECKER_CATALOG_TRIAL = 'checker-catalog';

/** Requests above this many input tokens are billed at a higher rate for the whole request. */
const MACHINE_CONTEXT_WINDOW = 272_000;
/** Codex sizes its skills list at 2% of the window when unset; machine work caps it here (Oct-2 T5). */
const MACHINE_SKILLS_MAX_CONTEXT_TOKENS = 1500;

export const CODEX_HARNESS_WORK_KINDS: readonly SessionKind[] = [
  'loop', 'plan-queue', 'child', 'automation', 'review',
];

export interface CodexThreadPolicy {
  level: 'off' | 'economy' | 'full';
  /** Includes output and compaction overrides exactly once. */
  config: Record<string, unknown>;
  outputLimit: number | null;
  postTurnCompactPercent: number | null;
  arm?: CodexTrialArm;
  armKey?: string | null;
  armSource?: TrialKeySource | null;
  catalog?: CodexSkillCatalog;
  checkerArm?: CodexCheckerArm;
}

/** The checker catalog trial's half: a salted hash of the same durable trial key. */
export function codexCheckerArm(key: string | null | undefined): CodexCheckerArm {
  return key ? createHash('sha256').update(`${CHECKER_CATALOG_TRIAL}:${key}`).digest()[0] % 2 === 0 ? 'control' : 'candidate' : 'unassigned';
}

export function codexCheckerCatalogSetting(value: unknown): CodexCheckerCatalogSetting {
  return value === 'full' || value === 'omit' ? value : 'trial';
}

/** The same raw key always picks the same half of its trial. */
export function resolveTrialArm(
  key: string | null | undefined,
  setting: CodexChatsSetting | CodexHarnessWorkSetting,
  isHarnessWork: boolean,
): CodexTrialArm {
  if (!key || setting !== 'trial') return 'unassigned';
  const firstByte = createHash('sha256').update(key).digest()[0];
  return firstByte % 2 === 0 ? (isHarnessWork ? 'off' : 'cheaper') : 'full';
}

/** Helper-agent overrides for a resolved level; the one source for both the controller and a remote worker. */
function helperAgentConfig(level: CodexThreadPolicy['level'], chat: boolean): Record<string, unknown> {
  const config: Record<string, unknown> = level === 'off'
    ? { 'agents.enabled': false }
    : level === 'economy'
      ? { 'agents.default_subagent_reasoning_effort': 'medium', 'agents.max_concurrent_threads_per_session': 2 }
      : {};
  // Chats only: helpers start clean (fork_turns "none") instead of re-reading the parent conversation.
  if (chat && level === 'economy') {
    config['features.multi_agent_v2.multi_agent_mode_hint_text'] = 'Start helpers only when asked or when the work is independent and long. Pass fork_turns="none" and put everything the helper needs in the message.';
  }
  return config;
}

export function resolveCodexThreadPolicy(input: {
  kind: SessionKind;
  /** Set by the queue for a plan over about 100 KB, where a 272K window would compact over and over. */
  planQueueLargeDocument?: boolean;
  chatsSetting?: CodexChatsSetting;
  harnessWorkSetting?: CodexHarnessWorkSetting;
  tuningSetting?: CodexTuningSetting;
  arm?: CodexTrialArm;
  queueRole?: string;
  checkerCatalogSetting?: CodexCheckerCatalogSetting;
  checkerArm?: CodexCheckerArm;
}): CodexThreadPolicy {
  const harnessWork = CODEX_HARNESS_WORK_KINDS.includes(input.kind);
  const selected = harnessWork ? input.harnessWorkSetting ?? 'trial' : input.chatsSetting ?? 'trial';
  const arm = input.arm ?? 'unassigned';
  const level = selected === 'trial'
    ? arm === 'off' && harnessWork ? 'off'
      : arm === 'cheaper' && !harnessWork ? 'economy' : 'full'
    : selected;
  const chat = input.kind === 'chat';
  const config = helperAgentConfig(level, chat);
  // Verified in the installed 0.163.0 config schema (20 October 2026, by the branch worker; not re-run here).
  // Ordinary helper children are included; personal chats retain Codex's budget.
  if (!chat) config['skills.max_context_tokens'] = MACHINE_SKILLS_MAX_CONTEXT_TOKENS;
  // Plan-queue checkers only. In 0.163.0 the flag removes just the automatic catalog block; skills named
  // in a turn are still injected (see codex-required-skills.ts).
  const checker = !chat && input.queueRole === 'verifier';
  const checkerSetting = input.checkerCatalogSetting ?? 'trial';
  const omitCatalog = checker && (checkerSetting === 'omit' || (checkerSetting === 'trial' && input.checkerArm === 'candidate'));
  if (omitCatalog) config['skills.include_instructions'] = false;
  const outputLimit = input.tuningSetting === 'codex' ? null : input.kind === 'chat' ? 6000 : 4000;
  const postTurnCompactPercent = input.tuningSetting === 'codex' ? null : input.kind === 'chat' ? 70 : 60;
  if (outputLimit !== null) config['tool_output_token_limit'] = outputLimit;
  if (postTurnCompactPercent !== null) config['model_post_turn_compact_threshold_percent'] = postTurnCompactPercent;
  // Harness-started Codex work stays under the 272K price break; own chats keep the model's full window.
  // Codex clamps the value to the model's maximum, so a wrong number cannot break a thread.
  if (!chat && input.tuningSetting !== 'codex' && !input.planQueueLargeDocument) config['model_context_window'] = MACHINE_CONTEXT_WINDOW;
  return {
    level, config, outputLimit, postTurnCompactPercent, arm,
    catalog: chat ? 'native' : omitCatalog ? 'omitted' : 'capped',
    ...(checker ? { checkerArm: input.checkerArm ?? 'unassigned' } : {}),
  };
}

/** True only in the Electron main process, the one place the settings store exists. */
function isElectronMainProcess(): boolean {
  return Boolean(process.versions.electron) && (process as NodeJS.Process & { type?: string }).type === 'browser';
}

let settingsStoreUnavailableLogged = false;
/** Test hook: lets the once-only log line fire again. */
export function _resetCodexThreadPolicyForTesting(): void {
  settingsStoreUnavailableLogged = false;
}

/**
 * What a worker without a settings store sends. The worker cannot read the controller's settings, so the only
 * overrides it applies are the helper-agent ones for the level the controller resolved and sent with the spawn
 * (`helperLevel`), the fixed skills cap for non-chat kinds, which no setting changes, and the checker's catalog
 * omission when the controller resolved it (`omitSkillCatalog`); with none, Codex's own defaults.
 */
function noPerThreadConfigPolicy(config: CodexCliConfig): CodexThreadPolicy {
  const level = config.helperLevel ?? 'full';
  const chat = (config.sessionKind ?? 'chat') === 'chat';
  const omitCatalog = !chat && config.queueRole === 'verifier' && config.omitSkillCatalog === true;
  const skills = chat ? {} : {
    'skills.max_context_tokens': MACHINE_SKILLS_MAX_CONTEXT_TOKENS,
    ...(omitCatalog ? { 'skills.include_instructions': false } : {}),
  };
  return {
    level, config: { ...helperAgentConfig(level, chat), ...skills }, outputLimit: null, postTurnCompactPercent: null,
    catalog: chat ? 'native' : omitCatalog ? 'omitted' : 'capped',
    arm: 'unassigned', armKey: config.trialKey ?? null, armSource: config.trialKeySource ?? null,
  };
}

/**
 * The helper-agent level the controller resolves for a remote Codex spawn from its own settings and trial arm,
 * to send to the worker. Fails closed in Electron main like `codexThreadPolicyForConfig`.
 */
export function codexHelperLevelForSpawn(spawn: Pick<CodexCliConfig, 'sessionKind' | 'trialKey' | 'trialKeySource' | 'trialArm'>): CodexThreadPolicy['level'] {
  return codexThreadPolicyForConfig({ ...spawn }).level;
}

/**
 * Whether the controller resolves that a remote Codex plan-queue checker runs without the skills catalog (its
 * setting and trial half), to send to the worker. Fails closed in Electron main like `codexThreadPolicyForConfig`.
 */
export function codexOmitSkillCatalogForSpawn(spawn: Pick<CodexCliConfig, 'sessionKind' | 'trialKey' | 'trialKeySource' | 'trialArm' | 'queueRole'>): boolean {
  return codexThreadPolicyForConfig({ ...spawn }).catalog === 'omitted';
}

/**
 * A settings failure inside Electron main is fatal: a guessed trial default could change paid
 * work. A plain-Node process (the remote worker bundle) has no settings store at all, so it
 * starts the thread with no per-thread config instead of failing the whole session.
 */
export function codexThreadPolicyForConfig(config: CodexCliConfig): CodexThreadPolicy {
  let settings: AppSettings;
  try {
    settings = getSettingsManager().getAll();
  } catch (error) {
    if (!isElectronMainProcess()) {
      if (!settingsStoreUnavailableLogged) {
        settingsStoreUnavailableLogged = true;
        logger.info('Codex thread policy: no settings store outside Electron main; starting threads with no per-thread config');
      }
      return noPerThreadConfigPolicy(config);
    }
    logger.warn('Codex thread policy could not read settings; failing closed', { ...errorDiagnostic(error) });
    throw error;
  }
  const kind = config.sessionKind ?? 'chat';
  const harnessWork = CODEX_HARNESS_WORK_KINDS.includes(kind);
  const setting = harnessWork ? settings.codexHelperAgentsHarnessWork ?? 'trial'
    : settings.codexHelperAgentsChats ?? 'trial';
  const arm = config.trialArm ?? resolveTrialArm(config.trialKey, setting, harnessWork);
  config.trialArm = arm;
  return {
    ...resolveCodexThreadPolicy({ kind, planQueueLargeDocument: config.planQueueLargeDocument, chatsSetting: settings.codexHelperAgentsChats,
      harnessWorkSetting: settings.codexHelperAgentsHarnessWork,
      tuningSetting: settings.codexContextTuning, arm, queueRole: config.queueRole,
      checkerCatalogSetting: codexCheckerCatalogSetting(settings.codexCheckerSkillCatalog),
      checkerArm: codexCheckerArm(config.trialKey) }),
    arm,
    armKey: config.trialKey ?? null,
    armSource: config.trialKeySource ?? null,
  };
}

/** Exec fallback has no thread/start RPC; pass the same machine cap as a CLI override and record it as effective. */
export function codexExecContextWindowArgs(config: CodexCliConfig): string[] {
  const window = codexExecMachineContextWindow(config);
  // Exec has no thread/start request to confirm the applied window, so the emitted override is what the
  // process runs with. Record it like `logPolicy` records an accepted app-server config, or context
  // diagnostics fall back to the stale catalogue.
  config.effectiveContextWindow = window;
  return window === undefined ? [] : ['-c', `model_context_window=${window}`];
}
function codexExecMachineContextWindow(config: CodexCliConfig): number | undefined {
  if (!config.sessionKind || config.sessionKind === 'chat' || config.planQueueLargeDocument) return undefined;
  const window = codexThreadPolicyForConfig(config).config['model_context_window'];
  return typeof window === 'number' ? window : undefined;
}
