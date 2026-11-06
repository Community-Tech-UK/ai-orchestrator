import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startCodexThread, resumeCodexThread } from './codex-thread-requests';
import { createCodexAdapter } from '../adapter-factory';
import type { CodexCliConfig } from '../codex-adapter-config';
import { recordSessionPolicy } from '../../../core/system/session-policy-log';

vi.mock('../../../core/system/session-policy-log', () => ({ recordSessionPolicy: vi.fn() }));

const policy={level:'off' as const,config:{'agents.enabled':false},outputLimit:4000,postTurnCompactPercent:60};
describe('Codex thread request policy transport',()=>{
  beforeEach(() => vi.mocked(recordSessionPolicy).mockClear());

  it.each(['skills.max_context_tokens', 'skills.include_instructions', 'features.multi_agent_v2.multi_agent_mode_hint_text'])('retries an unsupported %s override on start and resume', async (key) => {
    for (const resume of [false, true]) {
      const request = vi.fn().mockRejectedValueOnce(new Error(`unsupported ${key}`)).mockResolvedValue({ threadId: 'thread' });
      if (resume) await resumeCodexThread({ request }, { threadId: 'thread' }, policy);
      else await startCodexThread({ request }, { cwd: '/repo' }, policy);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1][1]).not.toHaveProperty('config');
    }
  });
  it('applies to starts/resumes and only drops config on an unsupported policy rejection',async()=>{
    const request=vi.fn().mockRejectedValueOnce(new Error('unknown field config')).mockResolvedValue({threadId:'thread'});
    await startCodexThread({request}, {cwd:'/repo'}, policy);
    expect(request.mock.calls[0][1]).toMatchObject({config:{'agents.enabled':false}});expect(request.mock.calls[1][1]).not.toHaveProperty('config');
    request.mockClear();await resumeCodexThread({request},{threadId:'thread'},policy);expect(request.mock.calls[0][1]).toMatchObject({config:{'agents.enabled':false},excludeTurns:true});
    const rejected=vi.fn().mockRejectedValue(new Error('connection closed'));
    await expect(startCodexThread({request:rejected},{cwd:'/repo'},policy)).rejects.toThrow('connection closed');expect(rejected).toHaveBeenCalledTimes(1);
  });

  it('logs the Harness instance on start and resume while keeping the provider thread as the resume target', async () => {
    const adapter = createCodexAdapter({
      instanceId: 'harness-instance-42', sessionId: 'native-thread-7', resume: true,
      sessionKind: 'automation', trialKey: 'automation-run-3', trialKeySource: 'automation', trialArm: 'off',
    });
    const config = (adapter as unknown as { cliConfig: CodexCliConfig }).cliConfig;
    const request = vi.fn(async () => ({ threadId: 'native-thread-7' }));
    const trialPolicy = { ...policy, arm: 'off' as const, armKey: 'automation-run-3', armSource: 'automation' as const };

    expect(config.sessionId).toBe('native-thread-7');
    await startCodexThread({ request }, { cwd: '/repo' }, trialPolicy, config);
    await resumeCodexThread({ request }, { threadId: config.sessionId! }, trialPolicy, config);

    expect(request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
      threadId: 'native-thread-7', config: expect.objectContaining({ 'agents.enabled': false }),
    }));
    expect(vi.mocked(recordSessionPolicy).mock.calls).toHaveLength(2);
    for (const [record] of vi.mocked(recordSessionPolicy).mock.calls) {
      expect(record).toMatchObject({
        provider: 'codex', threadId: 'native-thread-7', instanceId: 'harness-instance-42',
        sessionKind: 'automation', arm: 'off', armKey: 'automation-run-3', armSource: 'automation', applied: true,
      });
    }
  });

  it('leaves the Harness instance unknown for older configs with only a provider session ID', async () => {
    const adapter = createCodexAdapter({ sessionId: 'legacy-native-thread' });
    const config = (adapter as unknown as { cliConfig: CodexCliConfig }).cliConfig;
    const request = vi.fn(async () => ({ threadId: 'legacy-native-thread' }));

    await startCodexThread({ request }, { cwd: '/repo' }, policy, config);
    await resumeCodexThread({ request }, { threadId: config.sessionId! }, policy, config);

    expect(vi.mocked(recordSessionPolicy).mock.calls).toHaveLength(2);
    for (const [record] of vi.mocked(recordSessionPolicy).mock.calls) {
      expect(record.provider).toBe('codex');
      if (record.provider !== 'codex') continue;
      expect(record.instanceId).toBeUndefined();
      expect(JSON.stringify(record)).not.toContain('instanceId');
    }
  });
});

describe('Codex trial logging in the session-policy log', () => {
  const recorded = (): Record<string, unknown>[] => vi.mocked(recordSessionPolicy).mock.calls.map(([record]) => record as unknown as Record<string, unknown>);
  beforeEach(() => vi.mocked(recordSessionPolicy).mockClear());
  const checkerPolicy = {
    level: 'full' as const,
    config: { 'skills.max_context_tokens': 1500, 'skills.include_instructions': false, tool_output_token_limit: 4000 },
    outputLimit: 4000, postTurnCompactPercent: null, catalog: 'omitted' as const, checkerArm: 'candidate' as const,
  };

  it('records the arm, the override key names and the catalog of a started thread', async () => {
    const request = vi.fn().mockResolvedValue({ threadId: 'thread-1' });
    const config: CodexCliConfig = { sessionKind: 'plan-queue', trialKey: 'item-1', queueRole: 'verifier' };
    await startCodexThread({ request }, { cwd: '/repo' }, checkerPolicy, config);
    expect(recorded()[0]).toMatchObject({
      threadId: 'thread-1', sessionKind: 'plan-queue', operation: 'start', applied: true, catalog: 'omitted', checkerArm: 'candidate',
      configKeys: ['skills.include_instructions', 'skills.max_context_tokens', 'tool_output_token_limit'],
    });
    expect(config.skillCatalogOmitted).toBe(true);
  });

  it('records a rejected override set as no keys on Codex\'s own catalog, and leaves the catalog on', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('unsupported skills.include_instructions')).mockResolvedValue({ threadId: 'thread-2' });
    const config: CodexCliConfig = { sessionKind: 'plan-queue', trialKey: 'item-1', queueRole: 'verifier' };
    await resumeCodexThread({ request }, { threadId: 'thread-2' }, checkerPolicy, config);
    expect(recorded()[0]).toMatchObject({ threadId: 'thread-2', operation: 'resume', applied: false, catalog: 'native', configKeys: [], checkerArm: 'candidate' });
    expect(config.skillCatalogOmitted).toBe(false);
  });

  it('names the clean-helper hint key for a chat arm without logging its text', async () => {
    const request = vi.fn().mockResolvedValue({ threadId: 'thread-3' });
    const chatPolicy = {
      level: 'economy' as const,
      config: { 'agents.default_subagent_reasoning_effort': 'medium', 'features.multi_agent_v2.multi_agent_mode_hint_text': 'Pass fork_turns="none" and put everything the helper needs in the message.' },
      outputLimit: 6000, postTurnCompactPercent: 70, catalog: 'native' as const, arm: 'cheaper' as const,
    };
    await startCodexThread({ request }, { cwd: '/repo' }, chatPolicy, { trialKey: 'chat-1', trialArm: 'cheaper' });
    const [record] = recorded();
    expect(record).toMatchObject({ arm: 'cheaper', level: 'economy', catalog: 'native', configKeys: ['agents.default_subagent_reasoning_effort', 'features.multi_agent_v2.multi_agent_mode_hint_text'] });
    expect(record).not.toHaveProperty('checkerArm');
    expect(JSON.stringify(record)).not.toContain('fork_turns');
  });
});
