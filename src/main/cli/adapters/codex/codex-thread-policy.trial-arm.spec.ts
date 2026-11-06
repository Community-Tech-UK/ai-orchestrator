/**
 * Step 1c: which setting a Codex session kind follows, and how `trial` turns a
 * key into an arm. Everything goes through the real `codexThreadPolicyForConfig`
 * with only the settings store mocked, so the guarded lines in
 * `codex-thread-policy.ts` (the harness-work kinds, the arm-to-level mapping,
 * the hash polarity, `resolveTrialArm`, and `config.trialArm = arm`) are all on
 * the path.
 */

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionKind } from '../../../../shared/types/session-kind.types';
import type { CodexCliConfig } from '../codex-adapter-config';

const settingsMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => settingsMock.value }),
}));
vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { codexThreadPolicyForConfig } from './codex-thread-policy';

// sha256('run-1')[0] is even and sha256('run-2')[0] is odd; asserted below so a
// future key change cannot silently flip what these constants mean.
const EVEN_KEY = 'run-1';
const ODD_KEY = 'run-2';
const HARNESS_WORK_KINDS: readonly SessionKind[] = ['loop', 'plan-queue', 'child', 'automation', 'review'];

const OFF_CONFIG = { 'agents.enabled': false };
const ECONOMY_CONFIG = {
  'agents.default_subagent_reasoning_effort': 'medium',
  'agents.max_concurrent_threads_per_session': 2,
};

/** Only the helper-agent keys, so these cases do not restate the output caps. */
function agentKeys(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => key.startsWith('agents.')));
}

function policyFor(config: CodexCliConfig, settings: Record<string, unknown>) {
  settingsMock.value = settings;
  const policy = codexThreadPolicyForConfig(config);
  return { policy, config };
}

describe('Codex thread policy: trial follows the arm', () => {
  beforeEach(() => { settingsMock.value = {}; });

  it('uses keys whose hash parity is what these tests assume', () => {
    const parity = (key: string) => createHash('sha256').update(key).digest()[0] % 2;
    expect(parity(EVEN_KEY)).toBe(0);
    expect(parity(ODD_KEY)).toBe(1);
  });

  it.each(HARNESS_WORK_KINDS)('harness-work %s: even key is Off, odd key is Full, and the arm is stored', (kind) => {
    const even = policyFor({ sessionKind: kind, trialKey: EVEN_KEY },
      { codexHelperAgentsHarnessWork: 'trial', codexHelperAgentsChats: 'full' });
    expect(even.policy.level).toBe('off');
    expect(even.policy.arm).toBe('off');
    expect(agentKeys(even.policy.config)).toEqual(OFF_CONFIG);
    expect(even.config.trialArm).toBe('off');

    const odd = policyFor({ sessionKind: kind, trialKey: ODD_KEY },
      { codexHelperAgentsHarnessWork: 'trial', codexHelperAgentsChats: 'full' });
    expect(odd.policy.level).toBe('full');
    expect(odd.policy.arm).toBe('full');
    expect(agentKeys(odd.policy.config)).toEqual({});
    expect(odd.config.trialArm).toBe('full');
  });

  it('chat: even key is Cheaper, odd key is Full, and the arm is stored', () => {
    const even = policyFor({ sessionKind: 'chat', trialKey: EVEN_KEY },
      { codexHelperAgentsChats: 'trial', codexHelperAgentsHarnessWork: 'full' });
    expect(even.policy.level).toBe('economy');
    expect(even.policy.arm).toBe('cheaper');
    expect(agentKeys(even.policy.config)).toEqual(ECONOMY_CONFIG);
    expect(even.config.trialArm).toBe('cheaper');

    const odd = policyFor({ sessionKind: 'chat', trialKey: ODD_KEY },
      { codexHelperAgentsChats: 'trial', codexHelperAgentsHarnessWork: 'full' });
    expect(odd.policy.level).toBe('full');
    expect(odd.policy.arm).toBe('full');
    expect(agentKeys(odd.policy.config)).toEqual({});
    expect(odd.config.trialArm).toBe('full');
  });

  it('treats a missing sessionKind as a chat', () => {
    const even = policyFor({ trialKey: EVEN_KEY }, { codexHelperAgentsChats: 'trial', codexHelperAgentsHarnessWork: 'off' });
    expect(even.policy.level).toBe('economy');
  });

  it('defaults both settings to trial when they are absent', () => {
    expect(policyFor({ sessionKind: 'loop', trialKey: EVEN_KEY }, {}).policy.level).toBe('off');
    expect(policyFor({ sessionKind: 'chat', trialKey: EVEN_KEY }, {}).policy.level).toBe('economy');
  });

  it('keeps an arm already stored on the adapter config across resumes', () => {
    // The key now hashes to the other half, but the stored arm wins.
    const resumed = policyFor({ sessionKind: 'plan-queue', trialKey: ODD_KEY, trialArm: 'off' },
      { codexHelperAgentsHarnessWork: 'trial' });
    expect(resumed.policy.level).toBe('off');
    expect(resumed.config.trialArm).toBe('off');
  });

  it('never maps a chat arm onto harness work, or a harness arm onto a chat', () => {
    // A stored arm from the wrong family (for example a session whose kind changed) must not
    // switch helpers off for a chat or hand a loop the chat-only Cheaper level.
    expect(policyFor({ sessionKind: 'loop', trialKey: EVEN_KEY, trialArm: 'cheaper' },
      { codexHelperAgentsHarnessWork: 'trial' }).policy.level).toBe('full');
    expect(policyFor({ sessionKind: 'chat', trialKey: EVEN_KEY, trialArm: 'off' },
      { codexHelperAgentsChats: 'trial' }).policy.level).toBe('full');
  });
});

describe('Codex thread policy: which setting each kind follows', () => {
  it.each(HARNESS_WORK_KINDS)('%s uses the harness-work setting and ignores the chats setting', (kind) => {
    expect(policyFor({ sessionKind: kind },
      { codexHelperAgentsHarnessWork: 'off', codexHelperAgentsChats: 'full' }).policy.level).toBe('off');
    expect(policyFor({ sessionKind: kind },
      { codexHelperAgentsHarnessWork: 'full', codexHelperAgentsChats: 'off' }).policy.level).toBe('full');
    // The chats-only "economy" level is not even available to harness work.
    expect(policyFor({ sessionKind: kind },
      { codexHelperAgentsHarnessWork: 'full', codexHelperAgentsChats: 'economy' }).policy.level).toBe('full');
  });

  it('chat uses the chats setting and ignores the harness-work setting', () => {
    expect(policyFor({ sessionKind: 'chat' },
      { codexHelperAgentsChats: 'off', codexHelperAgentsHarnessWork: 'full' }).policy.level).toBe('off');
    expect(policyFor({ sessionKind: 'chat' },
      { codexHelperAgentsChats: 'economy', codexHelperAgentsHarnessWork: 'off' }).policy.level).toBe('economy');
    expect(policyFor({ sessionKind: 'chat' },
      { codexHelperAgentsChats: 'full', codexHelperAgentsHarnessWork: 'off' }).policy.level).toBe('full');
  });
});

describe('Codex thread policy: no arm unless the governing setting is trial', () => {
  it.each(['off', 'full'] as const)('harness-work setting %s assigns no arm, even with a key', (setting) => {
    const { policy, config } = policyFor({ sessionKind: 'loop', trialKey: EVEN_KEY },
      { codexHelperAgentsHarnessWork: setting, codexHelperAgentsChats: 'trial' });
    expect(policy.arm).toBe('unassigned');
    expect(config.trialArm).toBe('unassigned');
    expect(policy.level).toBe(setting);
  });

  it.each(['off', 'full', 'economy'] as const)('chats setting %s assigns no arm, even with a key', (setting) => {
    const { policy, config } = policyFor({ sessionKind: 'chat', trialKey: EVEN_KEY },
      { codexHelperAgentsChats: setting, codexHelperAgentsHarnessWork: 'trial' });
    expect(policy.arm).toBe('unassigned');
    expect(config.trialArm).toBe('unassigned');
    expect(policy.level).toBe(setting);
  });

  it('a trial setting with no key stays unassigned and runs Full', () => {
    const harness = policyFor({ sessionKind: 'loop' }, { codexHelperAgentsHarnessWork: 'trial' });
    expect(harness.policy).toMatchObject({ level: 'full', arm: 'unassigned' });
    expect(agentKeys(harness.policy.config)).toEqual({});
    const chat = policyFor({ sessionKind: 'chat', trialKey: '' }, { codexHelperAgentsChats: 'trial' });
    expect(chat.policy).toMatchObject({ level: 'full', arm: 'unassigned' });
  });
});
