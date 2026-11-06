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

import {
  resolveCodexThreadPolicy, resolveTrialArm, codexThreadPolicyForConfig, _resetCodexThreadPolicyForTesting,
} from './codex-thread-policy';

/** Pretend to be the Electron main process (versions.electron + type 'browser') for one test. */
function asElectronMain(): void {
  vi.stubGlobal('process', Object.create(process, {
    versions: { value: { ...process.versions, electron: '42.0.0' } },
    type: { value: 'browser' },
  }));
}

describe('Codex machine thread policy',()=>{
  it('keeps related queue instances on one deterministic arm and unknown keys unassigned',()=>{
    expect(resolveTrialArm('queue-item', 'trial', false)).toBe(resolveTrialArm('queue-item', 'trial', false));
    expect(resolveTrialArm(undefined, 'trial', false)).toBe('unassigned');
    const off=resolveCodexThreadPolicy({kind:'plan-queue',chatsSetting:'full',harnessWorkSetting:'off',tuningSetting:'harness'});
    expect(off.config).toEqual({'agents.enabled':false,tool_output_token_limit:4000,model_post_turn_compact_threshold_percent:60});
    expect(resolveCodexThreadPolicy({kind:'chat',chatsSetting:'economy',harnessWorkSetting:'off',tuningSetting:'codex'}).config).toEqual({'agents.default_subagent_reasoning_effort':'medium','agents.max_concurrent_threads_per_session':2});
    expect(resolveCodexThreadPolicy({kind:'plan-queue',chatsSetting:'economy',harnessWorkSetting:'trial',tuningSetting:'codex',arm:'unassigned'}).level).toBe('full');
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
      tool_output_token_limit: 4000,
      model_post_turn_compact_threshold_percent: 60,
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
