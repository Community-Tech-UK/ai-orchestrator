import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startCodexThread, resumeCodexThread } from './codex-thread-requests';
import { createCodexAdapter } from '../adapter-factory';
import type { CodexCliConfig } from '../codex-adapter-config';
import { recordSessionPolicy } from '../../../core/system/session-policy-log';

vi.mock('../../../core/system/session-policy-log', () => ({ recordSessionPolicy: vi.fn() }));

const policy={level:'off' as const,config:{'agents.enabled':false},outputLimit:4000,postTurnCompactPercent:60};
describe('Codex thread request policy transport',()=>{
  beforeEach(() => vi.mocked(recordSessionPolicy).mockClear());

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
