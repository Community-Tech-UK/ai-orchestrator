import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settingsMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  failure: null as Error | null,
}));

vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => {
      if (settingsMock.failure) throw settingsMock.failure;
      return settingsMock.value;
    },
  }),
}));

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../logging/logger', () => ({ getLogger: () => logMock }));

import { CodexCliAdapter } from '../codex-cli-adapter';
import type { CodexCliConfig } from '../codex-adapter-config';
import {
  resolveCodexThreadPolicy, resolveTrialArm, codexCheckerArm, codexThreadPolicyForConfig, codexExecPolicyArgs, _resetCodexThreadPolicyForTesting,
  codexHelperLevelForSpawn,
  codexOmitSkillCatalogForSpawn,
} from './codex-thread-policy';

/** Pretend to be the Electron main process (versions.electron + type 'browser') for one test. */
function asElectronMain(): void {
  vi.stubGlobal('process', Object.create(process, {
    versions: { value: { ...process.versions, electron: '42.0.0' } },
    type: { value: 'browser' },
  }));
}

describe('Codex machine thread policy',()=>{
  it('keeps the clean-helper hint in the economy chat arm only', () => {
    const candidate = resolveCodexThreadPolicy({ kind: 'chat', chatsSetting: 'trial', arm: 'cheaper' });
    expect(candidate.config['features.multi_agent_v2.multi_agent_mode_hint_text']).toContain('fork_turns="none"');
    expect(resolveCodexThreadPolicy({ kind: 'chat', chatsSetting: 'trial', arm: 'full' }).config).not.toHaveProperty('features.multi_agent_v2.multi_agent_mode_hint_text');
    expect(resolveCodexThreadPolicy({ kind: 'plan-queue', harnessWorkSetting: 'full' }).config).not.toHaveProperty('features.multi_agent_v2.multi_agent_mode_hint_text');
  });
  it.each(['child', 'loop', 'plan-queue', 'automation', 'review'] as const)('caps the skills catalog for %s even when helper agents are off', (kind) => {
    expect(resolveCodexThreadPolicy({ kind, harnessWorkSetting: 'off' }).config['skills.max_context_tokens']).toBe(1500);
    expect(resolveCodexThreadPolicy({ kind: 'chat' }).config).not.toHaveProperty('skills.max_context_tokens');
  });
  it('keeps related queue instances on one deterministic arm and unknown keys unassigned',()=>{
    expect(resolveTrialArm('queue-item', 'trial', false)).toBe(resolveTrialArm('queue-item', 'trial', false));
    expect(resolveTrialArm(undefined, 'trial', false)).toBe('unassigned');
    const off=resolveCodexThreadPolicy({kind:'plan-queue',chatsSetting:'full',harnessWorkSetting:'off',tuningSetting:'harness'});
    expect(off.config).toEqual({'agents.enabled':false,'skills.max_context_tokens':1500,tool_output_token_limit:4000,model_post_turn_compact_threshold_percent:60,model_context_window:272000});
    expect(resolveCodexThreadPolicy({kind:'chat',chatsSetting:'economy',harnessWorkSetting:'off',tuningSetting:'codex'}).config).toEqual({'agents.default_subagent_reasoning_effort':'medium','agents.max_concurrent_threads_per_session':2,'features.multi_agent_v2.multi_agent_mode_hint_text':expect.stringContaining('fork_turns="none"')});
    expect(resolveCodexThreadPolicy({kind:'plan-queue',chatsSetting:'economy',harnessWorkSetting:'trial',tuningSetting:'codex',arm:'unassigned'}).level).toBe('full');
  });
});

describe('Codex checker skills catalog trial', () => {
  const checker = (extra: Partial<Parameters<typeof resolveCodexThreadPolicy>[0]> = {}) =>
    resolveCodexThreadPolicy({ kind: 'plan-queue', harnessWorkSetting: 'full', queueRole: 'verifier', checkerArm: 'candidate', ...extra });

  it('omits the catalog for a checker in the candidate arm only, and keeps the cap key', () => {
    const candidate = checker();
    expect(candidate.config['skills.include_instructions']).toBe(false);
    expect(candidate.config['skills.max_context_tokens']).toBe(1500);
    expect(candidate.catalog).toBe('omitted');
    expect(candidate.checkerArm).toBe('candidate');
    const control = checker({ checkerArm: 'control' });
    expect(control.config).not.toHaveProperty('skills.include_instructions');
    expect(control.catalog).toBe('capped');
    expect(checker({ checkerArm: 'unassigned' }).config).not.toHaveProperty('skills.include_instructions');
  });

  it('honours the explicit setting over the arm, and never touches workers, triage or chats', () => {
    expect(checker({ checkerCatalogSetting: 'full' }).config).not.toHaveProperty('skills.include_instructions');
    expect(checker({ checkerCatalogSetting: 'omit', checkerArm: 'control' }).config['skills.include_instructions']).toBe(false);
    for (const queueRole of ['worker', 'triage', undefined]) {
      const other = checker({ queueRole });
      expect(other.config).not.toHaveProperty('skills.include_instructions');
      expect(other.checkerArm).toBeUndefined();
    }
    const chat = resolveCodexThreadPolicy({ kind: 'chat', queueRole: 'verifier', checkerArm: 'candidate' });
    expect(chat.config).not.toHaveProperty('skills.include_instructions');
    expect(chat.catalog).toBe('native');
  });

  it('splits on its own salt, so related sessions share an arm and it is independent of the helper-agent trial', () => {
    expect(codexCheckerArm('queue-item')).toBe(codexCheckerArm('queue-item'));
    const keys = Array.from({ length: 400 }, (_, index) => `item-${index}`);
    const checkerArms = keys.map((key) => codexCheckerArm(key));
    const helperArms = keys.map((key) => resolveTrialArm(key, 'trial', false));
    expect(checkerArms.filter((arm) => arm === 'candidate').length).toBeGreaterThan(150);
    expect(checkerArms.filter((arm) => arm === 'candidate').length).toBeLessThan(250);
    expect(checkerArms.some((arm, index) => (arm === 'candidate') !== (helperArms[index] === 'cheaper'))).toBe(true);
    expect(codexCheckerArm(undefined)).toBe('unassigned');
  });

  it('reads the queue role, trial key and setting from the spawn config', () => {
    settingsMock.value = { codexHelperAgentsHarnessWork: 'full', codexCheckerSkillCatalog: 'omit' };
    const omitted = codexThreadPolicyForConfig({ sessionKind: 'plan-queue', queueRole: 'verifier', trialKey: 'item-1' });
    expect(omitted.config['skills.include_instructions']).toBe(false);
    settingsMock.value = { codexHelperAgentsHarnessWork: 'full', codexCheckerSkillCatalog: 'nonsense' };
    const arm = codexCheckerArm('item-1');
    const trial = codexThreadPolicyForConfig({ sessionKind: 'plan-queue', queueRole: 'verifier', trialKey: 'item-1' });
    expect(trial.checkerArm).toBe(arm);
    expect('skills.include_instructions' in trial.config).toBe(arm === 'candidate');
    expect(codexThreadPolicyForConfig({ sessionKind: 'plan-queue', trialKey: 'item-1' }).config).not.toHaveProperty('skills.include_instructions');
  });
});

describe('codexThreadPolicyForConfig settings resolution', () => {
  beforeEach(() => {
    settingsMock.value = {};
    settingsMock.failure = null;
    _resetCodexThreadPolicyForTesting();
    vi.clearAllMocks();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('resolves the configured chat policy from settings instead of defaults', () => {
    settingsMock.value = { codexHelperAgentsChats: 'economy', codexContextTuning: 'codex' };
    const policy = codexThreadPolicyForConfig({});
    expect(policy.level).toBe('economy');
    expect(policy.config).toEqual({
      'agents.default_subagent_reasoning_effort': 'medium',
      'agents.max_concurrent_threads_per_session': 2,
      'features.multi_agent_v2.multi_agent_mode_hint_text': expect.stringContaining('fork_turns="none"'),
    });
    expect(policy.outputLimit).toBeNull();
    expect(policy.postTurnCompactPercent).toBeNull();
  });

  it('resolves the configured harness-work policy for non-chat kinds', () => {
    settingsMock.value = { codexHelperAgentsHarnessWork: 'off', codexContextTuning: 'harness' };
    const policy = codexThreadPolicyForConfig({ sessionKind: 'plan-queue' });
    expect(policy.level).toBe('off');
    expect(policy.config).toEqual({
      'agents.enabled': false,
      'skills.max_context_tokens': 1500,
      tool_output_token_limit: 4000,
      model_post_turn_compact_threshold_percent: 60,
      model_context_window: 272000,
    });
  });

  it('fails closed in the Electron main process instead of launching on trial defaults', () => {
    asElectronMain();
    settingsMock.failure = new Error('settings store unreadable');
    expect(() => codexThreadPolicyForConfig({})).toThrow('settings store unreadable');
    expect(logMock.warn).toHaveBeenCalledWith(expect.stringContaining('failing closed'), expect.anything());
  });

  it('starts with no per-thread config, and logs once, when the plain-Node worker has no settings store', () => {
    // Real message from the worker bundle: electron-store throws it when there is no Electron app.
    settingsMock.failure = new Error('Please specify the `projectName` option.');
    const config = { sessionKind: 'plan-queue' as const, trialKey: 'run-1', trialKeySource: 'loop-run' as const };
    const first = codexThreadPolicyForConfig(config);
    expect(first).toMatchObject({
      level: 'full', config: { 'skills.max_context_tokens': 1500 }, outputLimit: null, postTurnCompactPercent: null,
      arm: 'unassigned', armKey: 'run-1', armSource: 'loop-run',
    });
    expect(codexThreadPolicyForConfig({}).config).toEqual({});
    expect(logMock.info).toHaveBeenCalledTimes(1);
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(config).not.toHaveProperty('trialArm');
  });

  it('gives a worker the helper overrides for the level the controller sent, and nothing else', () => {
    settingsMock.failure = new Error('Please specify the `projectName` option.');
    const hint = expect.stringContaining('fork_turns="none"');
    expect(codexThreadPolicyForConfig({ sessionKind: 'chat', helperLevel: 'economy' })).toMatchObject({
      level: 'economy', outputLimit: null, postTurnCompactPercent: null,
      config: { 'agents.default_subagent_reasoning_effort': 'medium', 'agents.max_concurrent_threads_per_session': 2,
        'features.multi_agent_v2.multi_agent_mode_hint_text': hint },
    });
    // No sent level, a full level and a non-chat economy-looking level add no hint.
    expect(codexThreadPolicyForConfig({ sessionKind: 'chat' }).config).toEqual({});
    expect(codexThreadPolicyForConfig({ sessionKind: 'chat', helperLevel: 'full' }).config).toEqual({});
    expect(codexThreadPolicyForConfig({ sessionKind: 'plan-queue', helperLevel: 'economy' }).config).not.toHaveProperty('features.multi_agent_v2.multi_agent_mode_hint_text');
    // Non-chat kinds also get the fixed skills cap, which needs no setting; chats keep Codex's own list size.
    expect(codexThreadPolicyForConfig({ sessionKind: 'loop', helperLevel: 'off' }).config).toEqual({ 'agents.enabled': false, 'skills.max_context_tokens': 1500 });
    for (const sessionKind of ['loop', 'plan-queue', 'child', 'automation', 'review'] as const) {
      expect(codexThreadPolicyForConfig({ sessionKind }).config).toEqual({ 'skills.max_context_tokens': 1500 });
    }
  });

  it('gives a worker the checker catalog omission only when the controller sent it for a verifier', () => {
    settingsMock.failure = new Error('Please specify the `projectName` option.');
    const omit = { sessionKind: 'plan-queue' as const, queueRole: 'verifier', omitSkillCatalog: true };
    expect(codexThreadPolicyForConfig(omit)).toMatchObject({
      catalog: 'omitted', config: { 'skills.max_context_tokens': 1500, 'skills.include_instructions': false },
    });
    for (const other of [{ ...omit, omitSkillCatalog: false }, { ...omit, queueRole: 'worker' }, { ...omit, queueRole: undefined }, { ...omit, sessionKind: 'chat' as const }]) {
      expect(codexThreadPolicyForConfig(other).config).not.toHaveProperty('skills.include_instructions');
    }
    expect(codexThreadPolicyForConfig({ ...omit, omitSkillCatalog: false }).catalog).toBe('capped');
  });

  it('resolves, from the controller settings and arm, whether a remote checker omits the catalog', () => {
    const verifier = { sessionKind: 'plan-queue' as const, queueRole: 'verifier' };
    settingsMock.value = { codexCheckerSkillCatalog: 'omit' };
    expect(codexOmitSkillCatalogForSpawn({ ...verifier, trialKey: 'k' })).toBe(true);
    expect(codexOmitSkillCatalogForSpawn({ ...verifier, queueRole: 'worker', trialKey: 'k' })).toBe(false);
    settingsMock.value = { codexCheckerSkillCatalog: 'full' };
    expect(codexOmitSkillCatalogForSpawn({ ...verifier, trialKey: 'k' })).toBe(false);
    settingsMock.value = { codexCheckerSkillCatalog: 'trial' };
    expect(codexOmitSkillCatalogForSpawn({ ...verifier, trialKey: 'k' })).toBe(codexCheckerArm('k') === 'candidate');
  });

  it('resolves the level a controller sends to a worker from its own settings and arm', () => {
    settingsMock.value = { codexHelperAgentsChats: 'trial' };
    expect(codexHelperLevelForSpawn({ sessionKind: 'chat', trialArm: 'cheaper' })).toBe('economy');
    expect(codexHelperLevelForSpawn({ sessionKind: 'chat', trialArm: 'full' })).toBe('full');
    settingsMock.value = { codexHelperAgentsChats: 'economy' };
    expect(codexHelperLevelForSpawn({ sessionKind: 'chat' })).toBe('economy');
    settingsMock.value = { codexHelperAgentsHarnessWork: 'off' };
    expect(codexHelperLevelForSpawn({ sessionKind: 'plan-queue' })).toBe('off');
  });

  it('treats ELECTRON_RUN_AS_NODE (electron version but no browser process type) as a worker, not main', () => {
    vi.stubGlobal('process', Object.create(process, { versions: { value: { ...process.versions, electron: '42.0.0' } } }));
    settingsMock.failure = new Error('Please specify the `projectName` option.');
    expect(codexThreadPolicyForConfig({}).config).toEqual({});
  });
});


describe('machine context window boundary', () => {
  beforeEach(() => { settingsMock.value = {}; settingsMock.failure = null; });
  it.each(['child', 'loop', 'plan-queue', 'automation', 'review'] as const)('caps %s while retaining helper policy', (kind) => {
    expect(resolveCodexThreadPolicy({ kind, harnessWorkSetting: 'off' }).config).toMatchObject({ model_context_window: 272000, 'agents.enabled': false });
  });
  it('leaves chats, Codex tuning and large queue documents uncapped', () => {
    expect(resolveCodexThreadPolicy({ kind: 'chat' }).config).not.toHaveProperty('model_context_window');
    expect(resolveCodexThreadPolicy({ kind: 'loop', tuningSetting: 'codex' }).config).not.toHaveProperty('model_context_window');
    expect(resolveCodexThreadPolicy({ kind: 'plan-queue', planQueueLargeDocument: true }).config).not.toHaveProperty('model_context_window');
  });
  it('carries the exemption from the spawn configuration', () => {
    expect(codexThreadPolicyForConfig({ sessionKind: 'plan-queue', planQueueLargeDocument: true }).config).not.toHaveProperty('model_context_window');
  });
});


const SKILLS_CAP = ['-c', 'skills.max_context_tokens=1500'];
const WINDOW_CAP = ['-c', 'model_context_window=272000'];

it('caps exec fallback machine sessions and honors the same exceptions', () => {
  settingsMock.failure = null; settingsMock.value = { codexContextTuning: 'harness' };
  expect(codexExecPolicyArgs({ sessionKind: 'loop' })).toEqual([...WINDOW_CAP, ...SKILLS_CAP]);
  expect(codexExecPolicyArgs({ sessionKind: 'chat' })).toEqual([]);
  expect(codexExecPolicyArgs({ sessionKind: undefined })).toEqual([]);
  expect(codexExecPolicyArgs({ sessionKind: 'plan-queue', planQueueLargeDocument: true })).toEqual(SKILLS_CAP);
  settingsMock.value = { codexContextTuning: 'codex' };
  expect(codexExecPolicyArgs({ sessionKind: 'loop' })).toEqual(SKILLS_CAP);
});


it('records the emitted exec window as effective and leaves uncapped sessions unconfirmed', () => {
  settingsMock.failure = null; settingsMock.value = { codexContextTuning: 'harness' };
  const machine: CodexCliConfig = { sessionKind: 'loop' };
  expect(codexExecPolicyArgs(machine)).toEqual([...WINDOW_CAP, ...SKILLS_CAP]);
  expect(machine.effectiveContextWindow).toBe(272000);
  const chat: CodexCliConfig = { sessionKind: 'chat' };
  expect(codexExecPolicyArgs(chat)).toEqual([]);
  expect(chat.effectiveContextWindow).toBeUndefined();
  const exempt: CodexCliConfig = { sessionKind: 'plan-queue', planQueueLargeDocument: true };
  expect(codexExecPolicyArgs(exempt)).toEqual(SKILLS_CAP);
  expect(exempt.effectiveContextWindow).toBeUndefined();
  settingsMock.value = { codexContextTuning: 'codex' };
  const tuned: CodexCliConfig = { sessionKind: 'loop' };
  expect(codexExecPolicyArgs(tuned)).toEqual(SKILLS_CAP);
  expect(tuned.effectiveContextWindow).toBeUndefined();
});

describe('exec fallback skills catalog', () => {
  const checker: CodexCliConfig = { sessionKind: 'plan-queue', queueRole: 'verifier' };
  it('omits the checker catalog when the setting says omit, and records that for required-skill selection', () => {
    settingsMock.failure = null; settingsMock.value = { codexContextTuning: 'harness', codexCheckerSkillCatalog: 'omit' };
    const config = { ...checker };
    expect(codexExecPolicyArgs(config)).toEqual([...WINDOW_CAP, ...SKILLS_CAP, '-c', 'skills.include_instructions=false']);
    expect(config.skillCatalogOmitted).toBe(true);
  });
  it('keeps the full checker catalog (capped) when the setting says full', () => {
    settingsMock.failure = null; settingsMock.value = { codexContextTuning: 'harness', codexCheckerSkillCatalog: 'full' };
    const config = { ...checker };
    expect(codexExecPolicyArgs(config)).toEqual([...WINDOW_CAP, ...SKILLS_CAP]);
    expect(config.skillCatalogOmitted).toBe(false);
  });
  it('never touches the catalog of a chat', () => {
    settingsMock.failure = null; settingsMock.value = { codexCheckerSkillCatalog: 'omit' };
    const config: CodexCliConfig = { sessionKind: 'chat', queueRole: 'verifier', skillCatalogOmitted: true };
    expect(codexExecPolicyArgs(config)).toEqual([]);
    expect(config.skillCatalogOmitted).toBe(false);
  });
  it('applies the omission the controller resolved when there is no settings store (a worker)', () => {
    settingsMock.failure = new Error('no settings store'); settingsMock.value = {};
    const config: CodexCliConfig = { sessionKind: 'plan-queue', queueRole: 'verifier', omitSkillCatalog: true };
    expect(codexExecPolicyArgs(config)).toEqual([...SKILLS_CAP, '-c', 'skills.include_instructions=false']);
    expect(config.skillCatalogOmitted).toBe(true);
    const full: CodexCliConfig = { sessionKind: 'plan-queue', queueRole: 'verifier' };
    expect(codexExecPolicyArgs(full)).toEqual(SKILLS_CAP);
    expect(full.skillCatalogOmitted).toBe(false);
  });
});


it('puts the machine cap on the actual exec argv', () => {
  settingsMock.failure = null; settingsMock.value = { codexContextTuning: 'harness' };
  const adapter = new CodexCliAdapter({ sessionKind: 'loop' });
  const args = (adapter as unknown as { buildArgs(message: { role: string; content: string }): string[] }).buildArgs({ role: 'user', content: 'task' });
  expect(args.slice(0, 5)).toEqual([...WINDOW_CAP, ...SKILLS_CAP, 'exec']);
});
