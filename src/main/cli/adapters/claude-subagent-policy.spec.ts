import * as fs from 'node:fs';
import { statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_SUBAGENT_MODEL_MIN_VERSION,
  CLAUDE_SUBAGENT_WAITING_RULE_ROLLOUT,
  CLAUDE_SUBAGENT_WAITING_RULE,
  _resetSubagentPolicyForTesting,
  claudeSubagentArmForSession,
  materializeSubagentWaitingRuleFile,
  resolveClaudeSubagentEnv,
  resolveClaudeSubagentPromptArgs,
} from './claude-subagent-policy';

const ENV_KEYS = ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  _resetSubagentPolicyForTesting();
});

describe('claudeSubagentArmForSession', () => {
  it('splits sessions half-and-half on the last hex digit of the native id', () => {
    expect(claudeSubagentArmForSession('abc0')).toBe('sonnet');
    expect(claudeSubagentArmForSession('abc7')).toBe('sonnet');
    expect(claudeSubagentArmForSession('abc8')).toBe('same-as-session');
    expect(claudeSubagentArmForSession('abcf')).toBe('same-as-session');
    expect(claudeSubagentArmForSession('abcF')).toBe('same-as-session');
    // A non-hex tail never matches the sonnet half.
    expect(claudeSubagentArmForSession('sess-z')).toBe('same-as-session');
    expect(claudeSubagentArmForSession('')).toBe('same-as-session');
  });
});

describe('resolveClaudeSubagentEnv', () => {
  const base = {
    sessionModel: 'claude-opus-4-7',
    cliVersion: '2.1.296',
    env: {} as Record<string, string>,
  };

  it('parent gives nothing; sonnet gives the variable; trial follows the group', () => {
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'parent', arm: 'sonnet' })).toEqual({});
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'sonnet', arm: 'same-as-session' }))
      .toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' });
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'trial', arm: 'sonnet' }))
      .toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' });
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'trial', arm: 'same-as-session' })).toEqual({});
    // No session id at spawn: no group, no change under trial.
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'trial', arm: null })).toEqual({});
  });

  it('gates on the version: 2.1.250 or unknown gives nothing, 2.1.251 gives the variable', () => {
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'sonnet', cliVersion: '2.1.250' })).toEqual({});
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'sonnet', cliVersion: null })).toEqual({});
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'sonnet', cliVersion: '2.1.251' }))
      .toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' });
    expect(CLAUDE_SUBAGENT_MODEL_MIN_VERSION).toBe('2.1.251');
  });

  it('gives nothing for a session already on Sonnet or Haiku', () => {
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'sonnet', sessionModel: 'claude-sonnet-4-5' })).toEqual({});
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'sonnet', sessionModel: 'claude-haiku-4-5' })).toEqual({});
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'sonnet', sessionModel: 'sonnet' })).toEqual({});
    // An unknown session model counts as expensive.
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'sonnet', sessionModel: undefined }))
      .toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' });
  });

  it("James's choice wins: an existing variable in the spawn env or process env is unchanged", () => {
    expect(resolveClaudeSubagentEnv({
      ...base, setting: 'sonnet', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' },
    })).toEqual({});
    expect(resolveClaudeSubagentEnv({
      ...base, setting: 'sonnet', env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' },
    })).toEqual({});
    process.env['CLAUDE_CODE_SUBAGENT_MODEL'] = 'opus';
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'sonnet' })).toEqual({});
    delete process.env['CLAUDE_CODE_SUBAGENT_MODEL'];
    process.env['CLAUDE_CODE_SUBAGENT_MODEL_FORCE'] = '1';
    expect(resolveClaudeSubagentEnv({ ...base, setting: 'sonnet' })).toEqual({});
  });

  it('never sets _FORCE', () => {
    const resolved = resolveClaudeSubagentEnv({ ...base, setting: 'sonnet' });
    expect(Object.keys(resolved)).toEqual(['CLAUDE_CODE_SUBAGENT_MODEL']);
  });
});

describe('resolveClaudeSubagentPromptArgs', () => {
  it('keeps production rollout off until fork-cache sharing is proven', () => {
    expect(CLAUDE_SUBAGENT_WAITING_RULE_ROLLOUT).toBe(false);
    expect(resolveClaudeSubagentPromptArgs('2.1.296', '/tmp/rule.txt')).toEqual([]);
  });
  it('preserves the documented -file form and version gate under explicit probe opt-in', () => {
    expect(resolveClaudeSubagentPromptArgs('2.1.261', '/tmp/rule.txt', true))
      .toEqual(['--append-subagent-system-prompt-file', '/tmp/rule.txt']);
    expect(resolveClaudeSubagentPromptArgs('2.1.296', '/tmp/rule.txt', true)).toHaveLength(2);
    expect(resolveClaudeSubagentPromptArgs('2.1.260', '/tmp/rule.txt', true)).toEqual([]);
    expect(resolveClaudeSubagentPromptArgs(null, '/tmp/rule.txt', true)).toEqual([]);
  });
});

describe('materializeSubagentWaitingRuleFile', () => {
  it('writes the rule once per app run, mode 0600, holding exactly the waiting rule', () => {
    const first = materializeSubagentWaitingRuleFile();
    const second = materializeSubagentWaitingRuleFile();
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(fs.readFileSync(first!, 'utf8')).toBe(CLAUDE_SUBAGENT_WAITING_RULE);
    expect(statSync(first!).mode & 0o777).toBe(0o600);
  });
});
