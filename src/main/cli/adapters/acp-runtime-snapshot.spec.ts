import { describe, expect, it } from 'vitest';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';
import { captureResumeCursorForState } from '../../session/resume-cursor-capture';
import type { SessionState } from '../../session/session-continuity.types';

describe('OpenCode native recovery identity', () => {
  it('persists its confirmed native cursor through the normal continuity capture path', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    adapter.configureOpenCodeV2(true);
    expect(adapter.getRuntimeSnapshot().resumeCursor ?? null).toBeNull();
    await adapter.spawn();
    const state = { provider: 'opencode', modelId: 'fixture', workingDirectory: '/tmp' } as SessionState;
    captureResumeCursorForState({ adapter, instanceId: 'placeholder-instance', state,
      warn: () => { throw new Error('Native identity must be atomic'); } });
    expect(state.sessionId).toBe('sess-acp-1');
    expect(state.resumeCursor).toMatchObject({ provider: 'opencode', threadId: 'sess-acp-1',
      workspacePath: '/tmp', capturedAt: expect.any(Number), scanSource: 'native', configFingerprint: expect.any(String) });
    const captured = adapter.getRuntimeSnapshot();
    proc.exit(1);
    expect(adapter.getRuntimeSnapshot().resumeCursor).toEqual(captured.resumeCursor);
  });

  it('does not certify an opening session whose startup configuration fails', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp',
      sessionConfig: { model: 'fixture' }, requireSessionModelConfirmation: true });
    adapter.configureOpenCodeV2(true);
    proc.onRequest('session/set_config_option', (request) => proc.respondError(request.id, -32000, 'Fixture startup failure'));
    await expect(adapter.spawn()).rejects.toThrow();
    expect(adapter.getRuntimeSnapshot().resumeCursor ?? null).toBeNull();
    proc.exit();
  });
});
