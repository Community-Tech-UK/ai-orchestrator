import { describe, expect, it, vi } from 'vitest';
import type { AcpJsonRpcRequest, AcpSessionPromptParams } from '../../../shared/types/cli.types';
import { createInitializedAgentHarness, TestAcpCliAdapter, type FakeAcpProcess } from './acp-cli-adapter.test-helpers';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const prompts = (proc: FakeAcpProcess) => proc.receivedMessages
  .filter((message): message is AcpJsonRpcRequest<AcpSessionPromptParams> =>
    'method' in message && message.method === 'session/prompt')
  .map((message) => message.params!.prompt);

describe('ACP context queued for the next user turn', () => {
  it('includes context in the actual user prompt once and preserves it while a turn is busy', async () => {
    const proc = createInitializedAgentHarness();
    let active: AcpJsonRpcRequest | undefined;
    proc.onRequest('session/prompt', (message) => { active = message; });
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    await adapter.spawn();
    const first = adapter.sendMessage({ role: 'user', content: 'Already running' });
    await proc.waitForMessage((message) => 'method' in message && message.method === 'session/prompt');
    adapter.queueNextPromptContext('Continue the interrupted work on account B.');
    await expect(adapter.sendMessage({ role: 'user', content: 'Busy attempt' })).rejects.toThrow(/previous turn/);
    proc.respond(active!.id, { stopReason: 'end_turn' });
    await first;
    proc.onRequest('session/prompt', (message) => proc.respond(message.id, { stopReason: 'end_turn' }));
    await adapter.sendMessage({ role: 'user', content: 'Resume original work' });
    await adapter.sendMessage({ role: 'user', content: 'A later request' });
    expect(prompts(proc)).toEqual([
      [{ type: 'text', text: 'Already running' }],
      [{ type: 'text', text: 'Continue the interrupted work on account B.' }, { type: 'text', text: 'Resume original work' }],
      [{ type: 'text', text: 'A later request' }],
    ]);
    proc.exit();
  });

  it('preserves queued context after a rejected native write and consumes it on an accepted failed turn', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    await adapter.spawn();
    adapter.queueNextPromptContext('Replay continuity');
    const originalWrite = proc.stdin.write;
    proc.stdin.write = () => { throw new Error('Synthetic native rejection'); };
    await expect(adapter.sendMessage({ role: 'user', content: 'Unwritten' })).rejects.toThrow('Synthetic native rejection');
    proc.stdin.write = originalWrite;
    proc.onRequest('session/prompt', (message) => proc.respondError(message.id, -32000, 'Synthetic accepted turn failure'));
    await expect(adapter.sendMessage({ role: 'user', content: 'Accepted retry' })).rejects.toThrow('Synthetic accepted turn failure');
    proc.onRequest('session/prompt', (message) => proc.respond(message.id, { stopReason: 'end_turn' }));
    await adapter.sendMessage({ role: 'user', content: 'Later request' });
    expect(prompts(proc)).toEqual([
      [{ type: 'text', text: 'Replay continuity' }, { type: 'text', text: 'Accepted retry' }],
      [{ type: 'text', text: 'Later request' }],
    ]);
    proc.exit();
  });

  it('preserves context when dispatch is cancelled before provider acceptance', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', (message) => proc.respond(message.id, { stopReason: 'end_turn' }));
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    await adapter.spawn();
    adapter.queueNextPromptContext('Account switched');
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.sendMessage({ role: 'user', content: 'Cancelled' }, { signal: controller.signal }))
      .rejects.toThrow();
    await adapter.sendMessage({ role: 'user', content: 'Retry' });
    expect(prompts(proc)).toEqual([
      [{ type: 'text', text: 'Account switched' }, { type: 'text', text: 'Retry' }],
    ]);
    proc.exit();
  });
});
