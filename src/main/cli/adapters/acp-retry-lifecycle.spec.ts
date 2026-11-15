import { describe, expect, it } from 'vitest';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';
import type { OutputMessage } from '../../../shared/types/instance.types';

describe('OpenCode retry notice ownership', () => {
  it.each(['completion', 'error', 'interrupt', 'exit'] as const)('settles one notice after %s', async (ending) => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    adapter.configureOpenCodeV2(true);
    const outputs: OutputMessage[] = [];
    adapter.on('output', (output: OutputMessage) => outputs.push(output));
    await adapter.spawn();
    proc.onRequest('session/prompt', (request) => {
      for (const attempt of [1, 2, 3]) {
        for (const retry of [{ attempt, error: { status: 429, message: 'private provider body' } }, null]) {
          proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
            sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': retry },
          } });
        }
      }
      if (ending === 'completion') proc.respond(request.id, { stopReason: 'end_turn' });
      if (ending === 'error') proc.respondError(request.id, -32000, 'Fixture provider failure');
    });
    const result = adapter.sendMessage({ role: 'user', content: 'Harmless retry probe' });
    const settled = result.catch(() => undefined);
    if (ending === 'interrupt') {
      const interrupt = adapter.interrupt();
      if (interrupt.status === 'accepted') await interrupt.completion;
    }
    if (ending === 'exit') proc.exit(1);
    await settled;
    const notices = outputs.filter((output) => output.metadata?.['source'] === 'acp-retry-state');
    expect(notices.filter((notice) => notice.metadata?.['phase'] === 'attempting')).toHaveLength(3);
    expect(new Set(notices.map((notice) => notice.id)).size).toBe(1);
    expect(notices.at(-1)?.metadata).toMatchObject({ streaming: false, phase: ending === 'completion' ? 'recovered' : 'ended' });
    const retained = [...new Map(notices.map((notice) => [notice.id, notice])).values()];
    expect(retained).toHaveLength(1);
    expect(retained[0].content).not.toContain('trying the request again');
    expect(JSON.stringify(notices)).not.toContain('private provider body');
    proc.exit();
  });
});
