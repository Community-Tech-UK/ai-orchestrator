import { describe, expect, it } from 'vitest';
import type { AcpJsonRpcMessage } from '../../../shared/types/cli.types';
import { wireWorkerInteraction } from '../../../worker-agent/worker-instance-interaction';
import { createInitializedAgentHarness, TestAcpCliAdapter, type FakeAcpProcess } from './acp-cli-adapter.test-helpers';

function ask(proc: FakeAcpProcess, id = 'form') {
  proc.request(id, 'elicitation/create', {
    mode: 'form', message: 'Choose',
    requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } },
  });
}

/** Delay/fail the actual pipe callback, keeping adapter timeout and response paths real. */
function holdCancellation(proc: FakeAcpProcess, onlyResponse = false) {
  const original = proc.stdin._write.bind(proc.stdin);
  let release: ((error?: Error) => void) | undefined;
  const arrived = new Promise<void>((resolve) => {
    proc.stdin._write = (chunk: Buffer, encoding, callback) => {
      const message = JSON.parse(chunk.toString()) as AcpJsonRpcMessage;
      if (!release && (('result' in message && (message.result as { action?: string }).action === 'cancel')
        || (!onlyResponse && 'method' in message && message.method === 'session/cancel'))) {
        release = (error) => {
          proc.stdin._write = original;
          if (error) callback(error);
          else original(chunk, encoding, callback);
        };
        resolve();
      } else original(chunk, encoding, callback);
    };
  });
  return { arrived, release: (error?: Error) => { const complete = release; release = undefined; complete?.(error); } };
}

function harness() {
  const proc = createInitializedAgentHarness();
  const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', promptTimeoutMs: 100 });
  adapter.configureOpenCodeV2(true);
  const resolved: { id: string; reason: string }[] = [];
  adapter.on('input_required_resolved', (value) => resolved.push(value));
  proc.onRequest('session/prompt', () => ask(proc));
  return { proc, adapter, resolved };
}

describe('ACP prompt-timeout elicitation ownership', () => {
  it('withdraws the timed-out form and its correlated worker request, refusing late answers', async () => {
    const { proc, adapter, resolved } = harness();
    const remoteQuestions: { id: string }[] = [];
    const remoteResolutions: unknown[] = [];
    const worker = wireWorkerInteraction(adapter, () => true,
      (value) => remoteQuestions.push(value as { id: string }),
      (name, value) => { if (name === 'input_required_resolved') remoteResolutions.push(value); }, 'fixture-incarnation');
    await adapter.spawn();
    try {
      await expect(adapter.sendMessage({ role: 'user', content: 'Ask' })).rejects.toThrow(/timed out/);
      expect(adapter.hasActiveTurn()).toBe(false);
      expect(resolved).toEqual([{ id: 'acp_elicitation:form', reason: 'timeout' }]);
      expect(remoteQuestions).toHaveLength(1);
      expect(remoteResolutions).toEqual([{ interactionId: 'fixture-incarnation', payload: { id: remoteQuestions[0].id, reason: 'timeout' } }]);
      await expect(worker.interaction.answer(remoteQuestions[0].id,
        (key) => adapter.sendRaw('{"answer":"late"}', key), worker.resolved)).rejects.toThrow(/pending/);
      await expect(adapter.sendRaw('{"answer":"late"}', 'acp_elicitation:form')).rejects.toMatchObject({ code: 'INPUT_REQUIRED_NOT_PENDING' });
      expect(proc.receivedMessages).toContainEqual({ jsonrpc: '2.0', id: 'form', result: { action: 'cancel' } });
      expect(proc.receivedMessages.some((message) => 'method' in message && message.method === 'session/cancel')).toBe(true);
      expect(proc.receivedMessages.some((message) => 'result' in message && (message.result as { action?: string })?.action === 'accept')).toBe(false);
    } finally { worker.cleanup(); proc.exit(); }
  });

  it.each(['blocked', 'failed'] as const)('retires the form before a %s cancellation write can finish', async (mode) => {
    const { proc, adapter, resolved } = harness();
    await adapter.spawn();
    const hold = holdCancellation(proc);
    try {
      const turn = adapter.sendMessage({ role: 'user', content: 'Ask' });
      const timedOut = expect(turn).rejects.toThrow(/timed out/);
      await hold.arrived;
      await timedOut;
      if (mode === 'failed') hold.release(new Error('Fixture cancellation pipe failure'));
      expect(resolved).toEqual([{ id: 'acp_elicitation:form', reason: 'timeout' }]);
      await expect(adapter.sendRaw('{"answer":"late"}', 'acp_elicitation:form')).rejects.toMatchObject({ code: 'INPUT_REQUIRED_NOT_PENDING' });
      expect(proc.receivedMessages.some((message) => 'result' in message && (message.result as { action?: string })?.action === 'accept')).toBe(false);
    } finally {
      hold.release();
      proc.exit();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(resolved).toHaveLength(1);
  });

  it('does not erase a new-turn form with the same key when the old cancellation drains', async () => {
    const { proc, adapter, resolved } = harness();
    await adapter.spawn();
    const hold = holdCancellation(proc, true);
    try {
      await expect(adapter.sendMessage({ role: 'user', content: 'First' })).rejects.toThrow(/timed out/);
      // A cancellation response is still waiting for its native write callback.
      // The next turn can receive a new form before that old callback completes.
      proc.onRequest('session/prompt', () => undefined);
      const nextShown = new Promise<void>((resolve) => adapter.once('input_required', () => resolve()));
      const nextTurn = adapter.sendMessage({ role: 'user', content: 'Second' });
      const nextSettled = nextTurn.catch((error: unknown) => error);
      ask(proc);
      await nextShown;
      hold.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resolved).toEqual([{ id: 'acp_elicitation:form', reason: 'timeout' }]);
      await expect(adapter.sendRaw('{"answer":"current"}', 'acp_elicitation:form')).resolves.toBeUndefined();
      expect(proc.receivedMessages).toContainEqual({ jsonrpc: '2.0', id: 'form', result: { action: 'accept', content: { answer: 'current' } } });
      const prompts = proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt');
      const latest = prompts.at(-1);
      if (!latest || !('id' in latest) || latest.id === null) throw new Error('Expected a second prompt');
      proc.respond(latest.id, { stopReason: 'end_turn' });
      await expect(nextSettled).resolves.toHaveProperty('metadata.stopReason', 'end_turn');
    } finally { hold.release(); proc.exit(); }
  });
});
