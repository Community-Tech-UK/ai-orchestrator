import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import type { OutputMessage } from '../../../shared/types/instance.types';
import type { CliResponse } from './base-cli-adapter';
import { createInitializedAgentHarness, TestAcpCliAdapter, type FakeAcpProcess } from './acp-cli-adapter.test-helpers';

const update = (proc: FakeAcpProcess, payload: Record<string, unknown>) =>
  proc.notify('session/update', { sessionId: 'sess-acp-1', update: payload });

/** One OpenCode-shaped turn: thought, tool call, answer, usage_update, prompt result. */
function answerTurnLikeOpenCode(proc: FakeAcpProcess, options: { sessionCost?: number; withCost?: boolean } = {}): void {
  proc.onRequest('session/prompt', (message) => {
    update(proc, { sessionUpdate: 'agent_thought_chunk', messageId: 'msg-t1', content: { type: 'text', text: 'The user wants ' } });
    update(proc, { sessionUpdate: 'agent_thought_chunk', messageId: 'msg-t1', content: { type: 'text', text: 'the word.' } });
    update(proc, { sessionUpdate: 'agent_message_chunk', messageId: 'msg-a1', content: { type: 'text', text: 'pineapple' } });
    update(proc, {
      sessionUpdate: 'usage_update',
      used: 7813,
      size: 200000,
      ...(options.withCost === false ? {} : { cost: { amount: options.sessionCost ?? 0, currency: 'USD' } }),
    });
    proc.respond(message.id, {
      stopReason: 'end_turn',
      usage: { inputTokens: 104, outputTokens: 4, totalTokens: 7927, thoughtTokens: 11, cachedReadTokens: 7808 },
    });
  });
}

async function runTurn(proc: FakeAcpProcess) {
  const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
  const outputs: OutputMessage[] = [];
  const contexts: Array<Record<string, number>> = [];
  adapter.on('output', (message: OutputMessage) => outputs.push(message));
  adapter.on('context', (event: Record<string, number>) => contexts.push(event));
  await adapter.spawn();
  const response = await adapter.sendMessage({ role: 'user', content: 'Read secret.txt' });
  return { adapter, outputs, contexts, response };
}

describe('AcpCliAdapter agent_thought_chunk', () => {
  it('keeps thinking out of assistant text and attaches it to the turn message', async () => {
    const proc = createInitializedAgentHarness();
    answerTurnLikeOpenCode(proc);
    const { outputs, response } = await runTurn(proc);

    expect(response.content).toBe('pineapple');
    const assistant = outputs.filter((message) => message.type === 'assistant');
    for (const message of assistant) {
      expect(message.content).not.toContain('The user wants');
      expect(String(message.metadata?.['accumulatedContent'] ?? '')).not.toContain('The user wants');
    }
    const final = assistant.find((message) => message.metadata?.['streaming'] === false);
    expect(final?.content).toBe('pineapple');
    expect(final?.thinkingExtracted).toBe(true);
    expect(final?.thinking).toEqual([
      { id: expect.stringMatching(/-thought-0$/), content: 'The user wants the word.', format: 'sdk' },
    ]);
    proc.exit();
  });

  it('still shows the thinking of a turn that produced no answer text', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', (message) => {
      update(proc, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Only thinking.' } });
      proc.respond(message.id, { stopReason: 'end_turn' });
    });
    const { outputs } = await runTurn(proc);

    const final = outputs.find((message) => message.type === 'assistant');
    expect(final?.content).toBe('');
    expect(final?.thinking?.[0]?.content).toBe('Only thinking.');
    proc.exit();
  });

  it('drops thought chunks replayed outside a turn', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    const outputs: OutputMessage[] = [];
    adapter.on('output', (message: OutputMessage) => outputs.push(message));
    await adapter.spawn();
    update(proc, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'replayed' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(outputs).toEqual([]);
    proc.exit();
  });
});

describe('AcpCliAdapter usage_update', () => {
  it('drives the context meter from measured occupancy and reports it once per turn', async () => {
    const proc = createInitializedAgentHarness();
    answerTurnLikeOpenCode(proc);
    const { adapter, contexts } = await runTurn(proc);

    // One measured event; the prompt-result aggregate (7927 summed) is not emitted over it.
    expect(contexts).toEqual([{ used: 7813, total: 200000, percentage: expect.closeTo(3.9065, 3), cumulativeTokens: 0 }]);
    expect(adapter.getContextCapabilities().occupancyReporting).toBe('current');
    proc.exit();
  });

  it('keeps the aggregate context event for agents that send no usage_update', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', (message) => {
      update(proc, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
      proc.respond(message.id, { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } });
    });
    const { adapter, contexts } = await runTurn(proc);

    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ used: 7, cumulativeTokens: 7 });
    expect(adapter.getContextCapabilities().occupancyReporting).toBe('none');
    proc.exit();
  });

  it('records measured tokens and the turn cost from the running session total', async () => {
    const proc = createInitializedAgentHarness();
    answerTurnLikeOpenCode(proc, { sessionCost: 0.0125 });
    const { response } = await runTurn(proc);

    expect((response as CliResponse).usage).toMatchObject({
      inputTokens: 104,
      outputTokens: 4,
      cacheReadTokens: 7808,
      reasoningTokens: 11,
      cost: 0.0125,
    });
    expect(response.usage?.isEstimated).toBeUndefined();
    proc.exit();
  });

  it('records $0 when the agent reports no cost and reported cost is the only cost', async () => {
    const proc = createInitializedAgentHarness();
    answerTurnLikeOpenCode(proc, { withCost: false });
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', reportedCostOnly: true });
    await adapter.spawn();
    const response = await adapter.sendMessage({ role: 'user', content: 'Read secret.txt' });

    expect(response.usage?.inputTokens).toBe(104);
    expect(response.usage?.cost).toBe(0);
    proc.exit();
  });

  it('records tokens without a cost when usage_update carries none', async () => {
    const proc = createInitializedAgentHarness();
    answerTurnLikeOpenCode(proc, { withCost: false });
    const { response } = await runTurn(proc);

    expect(response.usage?.inputTokens).toBe(104);
    expect(response.usage?.cost).toBeUndefined();
    proc.exit();
  });
});
