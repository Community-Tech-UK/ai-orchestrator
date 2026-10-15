import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { resolveCodexThreadPolicy, codexTrialArm, codexThreadPolicyForConfig } from './codex-thread-policy';
describe('Codex machine thread policy',()=>{
  it('keeps related queue instances on one deterministic arm and unknown keys unassigned',()=>{
    expect(codexTrialArm('queue-item')).toBe(codexTrialArm('queue-item'));expect(codexTrialArm(undefined)).toBe('unassigned');
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
  });

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

  it('fails closed instead of launching on trial defaults when settings cannot be read', () => {
    settingsMock.failure = new Error('settings store unreadable');
    expect(() => codexThreadPolicyForConfig({})).toThrow('settings store unreadable');
  });
});
