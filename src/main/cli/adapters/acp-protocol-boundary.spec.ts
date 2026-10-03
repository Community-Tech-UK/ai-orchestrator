import { describe, expect, it, vi } from 'vitest';
import { MAX_ACP_RECORD_CHARS } from './acp-ndjson-framer';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';
import type { OutputMessage } from '../../../shared/types/instance.types';

const logs = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../logging/logger', () => ({ getLogger: () => logs }));

function assistantLine(text: string): string {
  return JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'sess-acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  } });
}

describe('ACP actual protocol boundaries', () => {
  it('recovers after complete and fragmented oversized records without fabricating assistant content', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    const output: OutputMessage[] = [];
    const errors: Error[] = [];
    adapter.on('output', (message) => output.push(message));
    adapter.on('error', (error) => errors.push(error));
    await adapter.spawn();
    proc.onRequest('session/prompt', (message) => {
      proc.stdout.write('x'.repeat(MAX_ACP_RECORD_CHARS));
      proc.stdout.write('overflow');
      expect((adapter as unknown as { stdoutBuffer: string }).stdoutBuffer).toBe('');
      proc.stdout.write(`${assistantLine('discarded suffix')}\n${assistantLine('x'.repeat(MAX_ACP_RECORD_CHARS))}\n`);
      const valid = `${assistantLine('recovered')}\r\n${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })}\n`;
      proc.stdout.write(valid.slice(0, 20));
      proc.stdout.write(valid.slice(20));
    });
    try {
      const response = await adapter.sendMessage({ role: 'user', content: 'synthetic prompt' });
      expect(response.content).toBe('recovered');
      expect(output.filter((message) => message.metadata?.['source'] === 'acp-protocol-error')).toHaveLength(2);
      expect(output.filter((message) => message.type === 'assistant').every((message) => message.content === 'recovered')).toBe(true);
      expect(errors).toEqual([]);
    } finally { proc.exit(); }
  });

  it('keeps parser, handler, unknown-field and stderr source bodies out of diagnostics', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    const notices: OutputMessage[] = [];
    adapter.on('output', (message) => { if (message.metadata?.['source'] === 'acp-protocol-error') notices.push(message); });
    await adapter.spawn();
    Object.values(logs).forEach((mock) => mock.mockClear());
    const marker = 'SYNTHETIC_SOURCE_SENTINEL';
    proc.stdout.write(`${marker} malformed\nnull\n`);
    proc.respond(marker, {});
    proc.notify(marker, {});
    proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: marker } });
    proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'session_info_update', title: marker } });
    proc.stderr.write('x'.repeat(1024 * 1024) + marker);
    proc.exit();
    expect(adapter.getStderrTail()?.length).toBeLessThanOrEqual(8192);
    expect(adapter.getStderrTail()).toContain(marker);
    expect(JSON.stringify(Object.values(logs).flatMap((mock) => mock.mock.calls))).not.toContain(marker);
    expect(JSON.stringify(notices)).not.toContain(marker);
    expect(notices[0]?.metadata).toMatchObject({ recoverable: true, errorKind: 'SyntaxError', lineChars: marker.length + ' malformed'.length, lineHash: expect.stringMatching(/^[a-f0-9]{16}$/) });
  });

  it('reports an inbound handler and rejected error reply safely without an unhandled rejection', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    const notices: OutputMessage[] = [];
    adapter.on('output', (message) => notices.push(message));
    await adapter.spawn();
    Object.values(logs).forEach((mock) => mock.mockClear());
    const marker = 'SYNTHETIC_HANDLER_SENTINEL';
    proc.stdin.write = () => { throw new Error(marker); };
    try {
      proc.request(marker, marker, {});
      await vi.waitFor(() => expect(notices).toHaveLength(2));
      expect(JSON.stringify(notices)).not.toContain(marker);
      expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(marker);
      expect(notices.every((notice) => notice.metadata?.['recoverable'] === true)).toBe(true);
    } finally { proc.exit(); }
  });
});
