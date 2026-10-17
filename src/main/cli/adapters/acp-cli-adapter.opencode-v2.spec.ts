import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';
import type { OutputMessage } from '../../../shared/types/instance.types';
import type { AcpSessionPromptResult } from '../../../shared/types/cli.types';

const fixture = JSON.parse(readFileSync(resolve(__dirname, 'opencode2-acp-session.fixture.json'), 'utf8')) as Record<string, Record<string, unknown>>;
interface TurnPacket { params?: { sessionId: string; update: Record<string, unknown> }; result?: AcpSessionPromptResult }
const turnFixture = JSON.parse(readFileSync(resolve(__dirname, 'opencode2-acp-turn.fixture.json'), 'utf8')) as Record<string, TurnPacket[]>;

function harness(options: Record<string, unknown> = {}) {
  const proc = createInitializedAgentHarness();
  proc.onRequest('initialize', (request) => proc.respond(request.id, {
    ...fixture['initialize'],
  }));
  const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', ...options });
  adapter.configureOpenCodeV2(true);
  const outputs: OutputMessage[] = [];
  adapter.on('output', (output: OutputMessage) => outputs.push(output));
  return { proc, adapter, outputs };
}

describe('OpenCode 2 ACP integration', () => {
  it('waits for durable prompt invalidation before every native prompt dispatch', async () => {
    let release: () => void = () => undefined;
    let checkpoints = 0;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const { proc, adapter } = harness({ beforeProviderPrompt: async () => { checkpoints++; await barrier; } });
    await adapter.spawn();
    proc.onRequest('session/prompt', (request) => proc.respond(request.id, { stopReason: 'end_turn' }));
    const first = adapter.sendMessage({ role: 'user', content: 'one' });
    expect(checkpoints).toBe(1);
    expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt')).toEqual([]);
    release();
    await first;
    await adapter.sendMessage({ role: 'user', content: 'two' });
    expect(checkpoints).toBe(2);
    proc.exit();
  });

  it('refuses a prompt when its durable invalidation fails', async () => {
    const { proc, adapter } = harness({ beforeProviderPrompt: async () => { throw new Error('Fixture checkpoint failure'); } });
    await adapter.spawn();
    proc.onRequest('session/prompt', (request) => proc.respond(request.id, { stopReason: 'end_turn' }));
    await expect(adapter.sendMessage({ role: 'user', content: 'one' })).rejects.toThrow('Fixture checkpoint failure');
    expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt')).toEqual([]);
    proc.exit();
  });

  it('does not advertise a native compaction hook that the adapter cannot call', async () => {
    const { proc, adapter } = harness();
    await adapter.spawn();
    expect(adapter.getRuntimeCapabilities().supportsNativeCompaction).toBe(false);
    proc.exit();
  });

  it('publishes load history transactionally before startup with parent messages and no live side effects', async () => {
    const { proc, adapter, outputs } = harness({ resume: true, sessionId: 'retained' });
    const histories: unknown[] = [];
    const tools: unknown[] = [];
    adapter.on('history_replay', (history) => histories.push(history));
    adapter.on('tool_use', (tool) => tools.push(tool));
    proc.onRequest('session/load', (request) => {
      const update = (value: Record<string, unknown>, sessionId = 'retained') => proc.notify('session/update', { sessionId, update: value });
      update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Original request' } });
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'First ' } });
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'answer.' } });
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'child', content: { type: 'text', text: 'private child answer' }, _meta: { 'opencode/child-session': { id: 'child', parentID: 'retained' } } });
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'other', content: { type: 'text', text: 'unrelated session' } }, 'other');
      update({ sessionUpdate: 'tool_call', toolCallId: 'read1', title: 'Read file', kind: 'read', status: 'completed', rawInput: { private: 'not replay metadata' } });
      update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] });
      expect(histories).toEqual([]);
      proc.respond(request.id, fixture['session/load']);
    });
    await adapter.spawn();
    expect(histories).toEqual([{ sessionId: 'retained', messages: [
      expect.objectContaining({ id: 'u1', type: 'user', content: 'Original request' }),
      expect.objectContaining({ id: 'a1', type: 'assistant', content: 'First answer.' }),
    ] }]);
    expect(JSON.stringify(histories)).not.toContain('private');
    expect(outputs).toEqual([]);
    expect(tools).toEqual([]);
    expect(adapter.getAvailableCommands()).toEqual([{ name: 'compact' }]);
    proc.exit();
  });

  it('discards failed load replay and pre-response command metadata', async () => {
    const { proc, adapter, outputs } = harness({ resume: true, sessionId: 'retained' });
    const histories: unknown[] = [];
    adapter.on('history_replay', (history) => histories.push(history));
    proc.onRequest('session/load', (request) => {
      proc.notify('session/update', { sessionId: 'retained', update: { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'Uncommitted history' } } });
      proc.notify('session/update', { sessionId: 'retained', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] } });
      proc.respondError(request.id, -32000, 'Fixture load failure');
    });
    await expect(adapter.spawn()).rejects.toThrow('Fixture load failure');
    expect(histories).toEqual([]);
    expect(outputs).toEqual([]);
    expect(adapter.getAvailableCommands()).toEqual([]);
    expect(adapter.getSessionId()).toBeNull();
    proc.exit();
  });

  it('rolls back the opening identity when replay exceeds its safe bound', async () => {
    const { proc, adapter } = harness({ resume: true, sessionId: 'retained' });
    const histories: unknown[] = [];
    adapter.on('history_replay', (history) => histories.push(history));
    proc.onRequest('session/load', (request) => {
      for (let index = 0; index <= 10_000; index++) proc.notify('session/update', { sessionId: 'retained', update: { sessionUpdate: 'user_message_chunk', messageId: `u${index}`, content: { type: 'text', text: 'hello' } } });
      proc.respond(request.id, fixture['session/load']);
    });
    await expect(adapter.spawn()).rejects.toThrow('refusing an incomplete restore');
    expect(histories).toEqual([]);
    expect(adapter.getSessionId()).toBeNull();
    proc.exit();
  });

  it('retains real resume metadata received before its response without replaying history', async () => {
    const { proc, adapter, outputs } = harness({ resume: true, sessionId: 'retained', preferSessionResume: true });
    const histories: unknown[] = [];
    adapter.on('history_replay', (history) => histories.push(history));
    proc.onRequest('session/resume', (request) => {
      proc.notify('session/update', { sessionId: 'retained', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] } });
      proc.respond(request.id, fixture['session/resume']);
    });
    await adapter.spawn();
    expect(adapter.getAvailableCommands()).toEqual([{ name: 'compact' }]);
    expect(histories).toEqual([]);
    expect(outputs).toEqual([]);
    proc.exit();
  });

  it.each(['continuation', 'child'])('replays real 2.0.30 %s frames with parent-only answer and prompt usage', async (scenario) => {
    const { proc, adapter } = harness();
    await adapter.spawn();
    proc.onRequest('session/prompt', (request) => {
      for (const packet of turnFixture[scenario]) {
        if (packet.params) {
          const params = JSON.parse(JSON.stringify(packet.params).replaceAll(packet.params.sessionId, 'sess-acp-1')) as TurnPacket['params'];
          proc.notify('session/update', params);
        } else if (packet.result) proc.respond(request.id, packet.result);
      }
    });
    const result = await adapter.sendMessage({ role: 'user', content: 'fixture' });
    expect(result.content).toBe(scenario === 'child' ? 'Continued answer.' : 'First part Continued answer.');
    expect(result.usage).toMatchObject({ inputTokens: 40, outputTokens: 36, totalTokens: 76 });
    expect(result.metadata?.['turnEnding']).toMatchObject({ reason: 'completed' });
    proc.exit();
  });
  it('clones an idle live source before releasing prompt admission and preserves source identity', async () => {
    const { proc, adapter } = harness();
    proc.onRequest('session/new', (request) => proc.respond(request.id, { sessionId: 'sess-acp-1', configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'fixture/source', options: [{ value: 'fixture/source' }] }] }));
    await adapter.spawn();
    const pending = adapter.forkNativeSession();
    const request = await proc.waitForMessage((message) => 'method' in message && message.method === 'session/fork');
    await expect(adapter.sendMessage({ role: 'user', content: 'racing input' })).rejects.toThrow('previous turn is still running');
    if ('id' in request) proc.respond(request.id!, { sessionId: 'immutable-fork', configOptions: [] });
    await expect(pending).resolves.toBe('immutable-fork');
    expect(adapter.getSessionId()).toBe('sess-acp-1');
    await expect(adapter.applyLiveSessionConfig({ model: 'fixture/source' })).resolves.toBeUndefined();
    proc.exit();
  });
  it('uses no-replay resume only when the caller already has the transcript', async () => {
    const { proc, adapter } = harness({ resume: true, sessionId: 'retained', preferSessionResume: true });
    proc.onRequest('session/resume', (request) => proc.respond(request.id, fixture['session/resume']));
    await adapter.spawn();
    expect(proc.receivedMessages).toContainEqual(expect.objectContaining({ method: 'session/resume', params: expect.objectContaining({ sessionId: 'retained' }) }));
    expect(adapter.getSessionId()).toBe('retained');
    expect(adapter.getResumeAttemptResult()?.confirmed).toBe(true);
    proc.exit();
  });

  it('forks to the new response identity and adopts config before metadata arrives', async () => {
    const { proc, adapter } = harness({ sessionId: 'original', forkSessionId: 'original' });
    proc.onRequest('session/fork', (request) => proc.respond(request.id, { ...fixture['session/fork'], sessionId: 'forked' }));
    await adapter.spawn();
    expect(adapter.getSessionId()).toBe('forked');
    expect(adapter.getRuntimeCapabilities().supportsForkSession).toBe(true);
    proc.exit();
  });

  it('advertises forms and compaction and sends additional directories on session creation', async () => {
    const { proc, adapter } = harness({ additionalDirectories: ['/tmp/shared'] });
    await adapter.spawn();
    expect(proc.receivedMessages).toContainEqual(expect.objectContaining({ method: 'initialize', params: expect.objectContaining({ clientCapabilities: expect.objectContaining({ elicitation: { form: {} }, session: { compaction: {} } }) }) }));
    expect(proc.receivedMessages).toContainEqual(expect.objectContaining({ method: 'session/new', params: expect.objectContaining({ additionalDirectories: ['/tmp/shared'] }) }));
    proc.exit();
  });

  it('narrates retry metadata and compaction without copying provider error bodies', async () => {
    const { proc, adapter, outputs } = harness();
    await adapter.spawn();
    proc.onRequest('session/prompt', (request) => {
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': { attempt: 2, error: { status: 429, message: 'private provider body' } } } } });
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'compaction_update', compactionId: 'compact-1', status: 'started' } });
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'compaction_update', compactionId: 'compact-1', status: 'completed' } });
      proc.respond(request.id, { stopReason: 'end_turn' });
    });
    await adapter.sendMessage({ role: 'user', content: 'go' });
    expect(outputs.some((output) => output.content.includes('retrying'))).toBe(true);
    expect(outputs.some((output) => output.content.includes('Compacting'))).toBe(true);
    expect(outputs.some((output) => output.content.includes('Compaction completed'))).toBe(true);
    expect(JSON.stringify(outputs)).not.toContain('private provider body');
    proc.exit();
  });

  it('keeps child answer text and usage separate while child work renews the parent task', async () => {
    const { proc, adapter } = harness({ promptTimeoutMs: 60, activeToolTimeoutMs: 90, delegatedTaskTimeoutMs: 1000 });
    await adapter.spawn();
    proc.onRequest('session/prompt', (request) => {
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'tool_call', toolCallId: 'parent-task', title: 'task', kind: 'think', status: 'in_progress', rawInput: { description: 'Review', prompt: 'review code' } } });
      const timer = setInterval(() => proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child-only' }, _meta: { 'opencode/child-session': { id: 'child', parentID: 'sess-acp-1', depth: 1, title: 'Review' } } } }), 30);
      setTimeout(() => {
        clearInterval(timer);
        proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'parent-task', status: 'completed' } });
        proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Parent answer.' } } });
        proc.respond(request.id, { stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3 } });
      }, 210);
    });
    const response = await adapter.sendMessage({ role: 'user', content: 'go' });
    expect(response.content).toBe('Parent answer.');
    expect(response.usage?.outputTokens).toBe(3);
    proc.exit();
  });

  it('does not misclassify aggregate continued output as a saturated final step', async () => {
    const plain = harness();
    await plain.adapter.spawn();
    plain.proc.onRequest('session/prompt', (request) => {
      plain.proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A continued reply without punctuation' } } });
      plain.proc.respond(request.id, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20000, thoughtTokens: 16000 } });
    });
    const response = await plain.adapter.sendMessage({ role: 'user', content: 'go' });
    expect(response.metadata?.['usageIsAggregate']).toBe(true);
    expect(response.metadata?.['turnEnding']).toMatchObject({ reason: 'completed' });
    plain.proc.exit();
  });

  it('retains the advertised command catalog without chat noise', async () => {
    const { proc, adapter, outputs } = harness();
    await adapter.spawn();
    proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact the session' }] } });
    expect(adapter.getAvailableCommands()).toEqual([{ name: 'compact', description: 'Compact the session' }]);
    expect(outputs).toEqual([]);
    proc.exit();
  });

  it('finalizes a retry notice when the prompt fails', async () => {
    const { proc, adapter, outputs } = harness();
    await adapter.spawn();
    proc.onRequest('session/prompt', (request) => {
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': { attempt: 1 } } } });
      proc.respondError(request.id, -32000, 'Fixture provider failure');
    });
    await expect(adapter.sendMessage({ role: 'user', content: 'run' })).rejects.toThrow();
    expect(outputs.filter((output) => output.metadata?.['source'] === 'acp-retry-state').at(-1)?.metadata?.['streaming']).toBe(false);
    proc.exit();
  });
});
