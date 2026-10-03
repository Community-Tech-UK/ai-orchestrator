import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';
import type { AcpJsonRpcSuccessResponse } from '../../../shared/types/cli.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

describe('OpenCode native doom-loop permission', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['bash', 'edit', 'write', 'unknown'])('rejects a repeated %s without presenting an approval card in YOLO', async (tool) => {
    const proc = createInitializedAgentHarness();
    let outcome: unknown;
    proc.onRequest('session/prompt', async (request) => {
      proc.request(70, 'session/request_permission', {
        sessionId: 'sess-acp-1',
        toolCall: { toolCallId: 'loop', title: 'doom_loop', kind: 'other', rawInput: { tool, input: {} } },
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const reply = await proc.waitForMessage((message) => 'id' in message && message.id === 70 && 'result' in message);
      outcome = (reply as AcpJsonRpcSuccessResponse).result;
      proc.respond(request.id, { stopReason: 'end_turn' });
    });
    const adapter = new TestAcpCliAdapter(proc, { adapterName: 'opencode-acp', workingDirectory: '/tmp', permissionContext: { instanceId: 'inst-1', yoloMode: true } });
    const shown = vi.fn();
    const outputs = vi.fn();
    adapter.on('input_required', shown);
    adapter.on('output', outputs);
    try {
      await adapter.sendMessage({ role: 'user', content: 'work' });
      expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
      expect(shown).not.toHaveBeenCalled();
      expect(outputs).toHaveBeenCalledWith(expect.objectContaining({ content: 'Blocked: identical tool call repeated. Change approach before retrying.', metadata: expect.objectContaining({ doomLoopBlocked: true }) }));
    } finally { proc.exit(); }
  });

  it.each(['read', 'grep', 'glob'])('allows native doom-loop requests for repeated %s', async (tool) => {
    const proc = createInitializedAgentHarness();
    let outcome: unknown;
    proc.onRequest('session/prompt', async (request) => {
      proc.request(71, 'session/request_permission', {
        toolCall: { toolCallId: 'loop', title: 'doom_loop', rawInput: { tool, input: {} } },
        options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
      });
      const reply = await proc.waitForMessage((message) => 'id' in message && message.id === 71 && 'result' in message);
      outcome = (reply as AcpJsonRpcSuccessResponse).result;
      proc.respond(request.id, { stopReason: 'end_turn' });
    });
    const adapter = new TestAcpCliAdapter(proc, { adapterName: 'opencode-acp', workingDirectory: '/tmp', permissionContext: { instanceId: 'inst-1', yoloMode: true } });
    try {
      await adapter.sendMessage({ role: 'user', content: 'search' });
      expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
    } finally { proc.exit(); }
  });
});
