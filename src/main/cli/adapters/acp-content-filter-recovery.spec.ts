import { describe, expect, it, vi } from 'vitest';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

describe('ACP content-filter recovery runtime hook', () => {
  it.each(['read', 'edit'])('retains the failing turn read-call proof for %s', async (kind) => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', (request) => {
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'tool_call', toolCallId: 'call_current', title: 'Inspect source', kind, status: 'in_progress' } });
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_current', status: 'completed' } });
      proc.respond(request.id, { stopReason: 'end_turn', finish: 'content_filter' });
    });
    const prepare = vi.fn(async () => true);
    const adapter = new TestAcpCliAdapter(proc, { adapterName: 'opencode-acp', workingDirectory: '/tmp', prepareContentFilterRecovery: prepare });
    try {
      await adapter.sendMessage({ role: 'user', content: 'inspect source' });
      const controller = new AbortController();
      expect(await adapter.prepareContentFilterRecovery(controller.signal)).toBe(kind === 'read');
      if (kind === 'read') expect(prepare).toHaveBeenCalledWith('sess-acp-1', 'call_current', controller.signal);
      else expect(prepare).not.toHaveBeenCalled();
      prepare.mockClear();
      controller.abort();
      expect(await adapter.prepareContentFilterRecovery(controller.signal)).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
    } finally { proc.exit(); }
  });
});
