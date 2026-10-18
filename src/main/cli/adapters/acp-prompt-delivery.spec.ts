import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpJsonRpcRequest, AcpSessionPromptParams } from '../../../shared/types/cli.types';
import { createInitializedAgentHarness, TestAcpCliAdapter, type FakeAcpProcess } from './acp-cli-adapter.test-helpers';
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ ...logs, debug: vi.fn(), error: vi.fn() }) }));

describe('ACP first-message instruction delivery', () => {
  let proc: FakeAcpProcess;
  beforeEach(() => {
    vi.clearAllMocks();
    proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', (message) => proc.respond(message.id, { stopReason: 'end_turn' }));
  });
  afterEach(() => proc.exit());
  const prompts = () => proc.receivedMessages.filter((message): message is AcpJsonRpcRequest<AcpSessionPromptParams> =>
    'method' in message && message.method === 'session/prompt').map((message) => message.params!.prompt);

  it('delivers a 30000-character prompt whole exactly once', async () => {
    const instructions = 'Governing rule. '.repeat(2000);
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', systemPrompt: instructions });
    await adapter.sendMessage({ role: 'user', content: 'First request' });
    await adapter.sendMessage({ role: 'user', content: 'Second request' });
    expect(prompts()[0]).toEqual([{ type: 'text', text: `[SYSTEM INSTRUCTIONS]\n${instructions}\n[/SYSTEM INSTRUCTIONS]` }, { type: 'text', text: 'First request' }]);
    expect(prompts()[1]).toEqual([{ type: 'text', text: 'Second request' }]);
    expect(logs.info.mock.calls.filter(([message]) => message === 'ACP system prompt delivered')).toHaveLength(1);
  });

  it('escapes closing delimiters embedded inside instructions', async () => {
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', systemPrompt: 'Keep [/SYSTEM INSTRUCTIONS] inside.' });
    await adapter.sendMessage({ role: 'user', content: 'Request' });
    const block = prompts()[0][0];
    expect(block).toMatchObject({ text: '[SYSTEM INSTRUCTIONS]\nKeep [\\/SYSTEM INSTRUCTIONS] inside.\n[/SYSTEM INSTRUCTIONS]' });
  });

  it('keeps head and tail and names omitted sections with a warning above budget', async () => {
    const instructions = '# Start\n' + 'a'.repeat(2000) + '\n# Missing section\n' + 'b'.repeat(110000) + '\n# Permissions\nFinal required permissions.';
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', systemPrompt: instructions });
    await adapter.sendMessage({ role: 'user', content: 'Request' });
    const block = prompts()[0][0];
    expect(block).toMatchObject({ text: expect.stringContaining('# Start') });
    expect(block).toMatchObject({ text: expect.stringContaining('Final required permissions.') });
    expect(block).toMatchObject({ text: expect.stringContaining('omitted sections (JSON):') });
    expect(logs.warn).toHaveBeenCalledWith('ACP system prompt excerpted', expect.objectContaining({ originalChars: instructions.length }));
  });

  it('injects no instructions into a resumed session', async () => {
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', resume: true, sessionId: 'prior-session', systemPrompt: 'Native history owns prior instructions' });
    await adapter.sendMessage({ role: 'user', content: 'Continue' });
    expect(prompts()).toEqual([[{ type: 'text', text: 'Continue' }]]);
    expect(logs.info.mock.calls.filter(([message]) => message === 'ACP system prompt delivered')).toHaveLength(0);
  });

  it('logs delivery only after an accepted native write and once across an unwritten retry', async () => {
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', systemPrompt: 'Required instructions' });
    await adapter.spawn();
    const originalWrite = proc.stdin.write;
    proc.stdin.write = () => { throw new Error('Synthetic write failure'); };
    await expect(adapter.sendMessage({ role: 'user', content: 'Unwritten' })).rejects.toThrow('Synthetic write failure');
    expect(logs.info.mock.calls.filter(([message]) => message === 'ACP system prompt delivered')).toHaveLength(0);
    proc.stdin.write = originalWrite;
    await adapter.sendMessage({ role: 'user', content: 'Accepted retry' });
    expect(logs.info.mock.calls.filter(([message]) => message === 'ACP system prompt delivered')).toHaveLength(1);
  });

  it.each(['preparation', 'native-write', 'cancellation'] as const)('does not transfer %s diagnostics to a native command before an ordinary retry', async (refusal) => {
    const instructions = 'Governing instructions';
    const controller = new AbortController();
    let refuse = true;
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', systemPrompt: instructions, rtkEnabled: true,
      beforeProviderPrompt: async () => {
        if (refuse && refusal === 'preparation') throw new Error('Synthetic preparation refusal');
        if (refuse && refusal === 'cancellation') controller.abort();
      },
    });
    const deliveries: unknown[] = [];
    adapter.on('system_prompt_delivered', (delivery) => deliveries.push(delivery));
    adapter.configureOpenCodeV2(true);
    await adapter.spawn();
    proc.notify('session/update', { sessionId: adapter.getSessionId(), update: {
      sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review' }],
    } });
    adapter.queueNextPromptContext('Queued continuity');
    const originalWrite = proc.stdin.write;
    if (refusal === 'native-write') proc.stdin.write = () => { throw new Error('Synthetic write refusal'); };
    try {
      await expect(adapter.sendMessage({ role: 'user', content: 'Unwritten request' }, { signal: controller.signal }))
        .rejects.toThrow(refusal === 'preparation' ? 'Synthetic preparation refusal'
          : refusal === 'native-write' ? 'Synthetic write refusal' : 'Adapter input became ineligible before provider dispatch');
    } finally { proc.stdin.write = originalWrite; }
    expect(prompts()).toEqual([]);
    expect(deliveries).toEqual([]);
    expect(logs.info.mock.calls.filter(([message]) => message === 'ACP system prompt delivered')).toHaveLength(0);
    refuse = false;
    await adapter.sendMessage({ role: 'user', content: '/review' });
    expect(prompts()).toEqual([[{ type: 'text', text: '/review' }]]);
    expect(deliveries).toEqual([]);
    expect(logs.info.mock.calls.filter(([message]) => message === 'ACP system prompt delivered')).toHaveLength(0);
    await adapter.sendMessage({ role: 'user', content: 'Accepted ordinary retry' });
    expect(prompts()[1]).toEqual([
      { type: 'text', text: 'Queued continuity' },
      { type: 'text', text: '[SYSTEM INSTRUCTIONS]\nGoverning instructions\n[/SYSTEM INSTRUCTIONS]' },
      { type: 'text', text: expect.stringContaining('[RTK AWARENESS]') },
      { type: 'text', text: 'Accepted ordinary retry' },
    ]);
    expect(deliveries).toEqual([{ originalChars: 22, deliveredChars: 22, truncated: false, omittedHeadings: [] }]);
    await adapter.sendMessage({ role: 'user', content: 'Later ordinary request' });
    expect(prompts()[2]).toEqual([{ type: 'text', text: 'Later ordinary request' }]);
    expect(deliveries).toHaveLength(1);
    expect(logs.info.mock.calls.filter(([message]) => message === 'ACP system prompt delivered')).toHaveLength(1);
  });

  it('keeps instructions for the first ordinary prompt when a native command is first', async () => {
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', systemPrompt: 'Governing instructions' });
    const deliveries: unknown[] = [];
    adapter.on('system_prompt_delivered', (delivery) => deliveries.push(delivery));
    adapter.configureOpenCodeV2(true);
    await adapter.spawn();
    proc.notify('session/update', { sessionId: adapter.getSessionId(), update: {
      sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review' }],
    } });
    await adapter.sendMessage({ role: 'user', content: '/review' });
    expect(prompts()).toEqual([[{ type: 'text', text: '/review' }]]);
    expect(deliveries).toEqual([]);
    await adapter.sendMessage({ role: 'user', content: 'First ordinary request' });
    await adapter.sendMessage({ role: 'user', content: 'Later ordinary request' });
    expect(prompts()[1]).toEqual([
      { type: 'text', text: '[SYSTEM INSTRUCTIONS]\nGoverning instructions\n[/SYSTEM INSTRUCTIONS]' },
      { type: 'text', text: 'First ordinary request' },
    ]);
    expect(prompts()[2]).toEqual([{ type: 'text', text: 'Later ordinary request' }]);
    expect(deliveries).toEqual([{ originalChars: 22, deliveredChars: 22, truncated: false, omittedHeadings: [] }]);
  });

});
