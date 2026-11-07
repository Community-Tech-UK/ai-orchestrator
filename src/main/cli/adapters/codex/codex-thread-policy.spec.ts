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
  resolveCodexThreadPolicy, resolveTrialArm, codexCheckerArm, codexThreadPolicyForConfig, codexExecContextWindowArgs, _resetCodexThreadPolicyForTesting,
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
      level: 'full', config: {}, outputLimit: null, postTurnCompactPercent: null,
      arm: 'unassigned', armKey: 'run-1', armSource: 'loop-run',
    });
    expect(codexThreadPolicyForConfig({}).config).toEqual({});
    expect(logMock.info).toHaveBeenCalledTimes(1);
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(config).not.toHaveProperty('trialArm');
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


it('caps exec fallback machine sessions and honors the same exceptions', () => {
  settingsMock.failure = null; settingsMock.value = { codexContextTuning: 'harness' };
  expect(codexExecContextWindowArgs({ sessionKind: 'loop' })).toEqual(['-c', 'model_context_window=272000']);
  expect(codexExecContextWindowArgs({ sessionKind: 'chat' })).toEqual([]);
  expect(codexExecContextWindowArgs({ sessionKind: 'plan-queue', planQueueLargeDocument: true })).toEqual([]);
  settingsMock.value = { codexContextTuning: 'codex' };
  expect(codexExecContextWindowArgs({ sessionKind: 'loop' })).toEqual([]);
});


it('records the emitted exec window as effective and leaves uncapped sessions unconfirmed', () => {
  settingsMock.failure = null; settingsMock.value = { codexContextTuning: 'harness' };
  const machine: CodexCliConfig = { sessionKind: 'loop' };
  expect(codexExecContextWindowArgs(machine)).toEqual(['-c', 'model_context_window=272000']);
  expect(machine.effectiveContextWindow).toBe(272000);
  const chat: CodexCliConfig = { sessionKind: 'chat' };
  expect(codexExecContextWindowArgs(chat)).toEqual([]);
  expect(chat.effectiveContextWindow).toBeUndefined();
  const exempt: CodexCliConfig = { sessionKind: 'plan-queue', planQueueLargeDocument: true };
  expect(codexExecContextWindowArgs(exempt)).toEqual([]);
  expect(exempt.effectiveContextWindow).toBeUndefined();
  settingsMock.value = { codexContextTuning: 'codex' };
  const tuned: CodexCliConfig = { sessionKind: 'loop' };
  expect(codexExecContextWindowArgs(tuned)).toEqual([]);
  expect(tuned.effectiveContextWindow).toBeUndefined();
});


it('puts the machine cap on the actual exec argv', () => {
  settingsMock.failure = null; settingsMock.value = { codexContextTuning: 'harness' };
  const adapter = new CodexCliAdapter({ sessionKind: 'loop' });
  const args = (adapter as unknown as { buildArgs(message: { role: string; content: string }): string[] }).buildArgs({ role: 'user', content: 'task' });
  expect(args.slice(0, 3)).toEqual(['-c', 'model_context_window=272000', 'exec']);
});
