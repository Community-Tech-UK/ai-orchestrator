import { describe, it, expect, beforeEach } from 'vitest';
import { ScriptedCliAdapter, type InterruptFaultMode } from './scripted-cli-adapter';
import { ReceiptBus } from './receipt-bus';
import {
  awaitReceipt,
  byType,
  drainRuntime,
  errorTurn,
  multiChunkTurn,
  simpleTextTurn,
  toolUseTurn,
} from './scripted-cli-adapter.test-helpers';
import type { CliMessage } from './base-cli-adapter.types';

const userMessage: CliMessage = { role: 'user', content: 'hi' };

describe('ScriptedCliAdapter', () => {
  let adapter: ScriptedCliAdapter;

  beforeEach(() => {
    adapter = new ScriptedCliAdapter();
  });

  it('plays a simple text turn and returns a CliResponse', async () => {
    adapter.enqueueTurn(simpleTextTurn('Hello world'));
    const response = await adapter.sendMessage(userMessage);

    expect(response.role).toBe('assistant');
    expect(response.content).toBe('Hello world');
    expect(response.usage?.outputTokens).toBeGreaterThan(0);
  });

  it('records receipts mirroring the emitted events, in order', async () => {
    adapter.enqueueTurn(simpleTextTurn('hey'));
    await adapter.sendMessage(userMessage);

    expect(adapter.receipts.all().map((r) => r.type)).toEqual([
      'spawned',
      'output',
      'complete',
    ]);
    // Sequence numbers are monotonic.
    const seqs = adapter.receipts.all().map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('emits spawned only once across multiple turns', async () => {
    adapter.enqueueResponse('one').enqueueResponse('two');
    await adapter.sendMessage(userMessage);
    await adapter.sendMessage(userMessage);

    expect(adapter.receipts.ofType('spawned')).toHaveLength(1);
    expect(adapter.receipts.ofType('complete')).toHaveLength(2);
  });

  it('streams text chunks via sendMessageStream', async () => {
    adapter.enqueueTurn(multiChunkTurn(['a', 'b', 'c']));
    const chunks: string[] = [];
    for await (const chunk of adapter.sendMessageStream(userMessage)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['a', 'b', 'c']);
    expect(adapter.receipts.ofType('output').map((r) => r.payload)).toEqual(['a', 'b', 'c']);
    expect(adapter.receipts.ofType('complete')).toHaveLength(1);
  });

  it('plays a tool-use turn with status/tool_use/tool_result/complete', async () => {
    adapter.enqueueTurn(toolUseTurn());
    const response = await adapter.sendMessage(userMessage);

    expect(adapter.receipts.all().map((r) => r.type)).toEqual([
      'spawned',
      'status',
      'tool_use',
      'tool_result',
      'output',
      'complete',
    ]);
    expect(response.toolCalls?.[0]?.name).toBe('Read');
    // The tool_use receipt carries the invocation without the result baked in.
    const toolUse = adapter.receipts.ofType('tool_use')[0];
    expect(toolUse.payload.result).toBeUndefined();
    const toolResult = adapter.receipts.ofType('tool_result')[0];
    expect(toolResult.payload.result).toBe('file contents');
  });

  it('synthesises a completion when the turn has no explicit complete step', async () => {
    adapter.enqueueTurn([{ kind: 'output', content: 'partial' }]);
    const response = await adapter.sendMessage(userMessage);

    expect(response.content).toBe('partial');
    expect(adapter.receipts.ofType('complete')).toHaveLength(1);
  });

  it('uses the default turn when the queue is empty', async () => {
    adapter.setDefaultTurn(simpleTextTurn('fallback'));
    const response = await adapter.sendMessage(userMessage);
    expect(response.content).toBe('fallback');
  });

  it('supports turn functions that branch on the incoming message', async () => {
    adapter.enqueueTurn((msg) => simpleTextTurn(`echo:${msg.content}`));
    const response = await adapter.sendMessage({ role: 'user', content: 'ping' });
    expect(response.content).toBe('echo:ping');
  });

  it('rejects the turn when an error step is marked fail', async () => {
    adapter.enqueueTurn(errorTurn('boom', true));
    await expect(adapter.sendMessage(userMessage)).rejects.toThrow('boom');
    expect(adapter.receipts.ofType('error')).toHaveLength(1);
  });

  it('emits a non-fatal error step without rejecting', async () => {
    adapter.enqueueTurn([{ kind: 'error', error: 'soft' }, { kind: 'complete' }]);
    await expect(adapter.sendMessage(userMessage)).resolves.toBeDefined();
    expect(adapter.receipts.ofType('error')).toHaveLength(1);
  });

  describe('lifecycle (synthetic process)', () => {
    it('is idle with no pid before the first turn', async () => {
      expect(adapter.isRunning()).toBe(false);
      expect(adapter.getPid()).toBeNull();
      expect(adapter.interrupt().status).toBe('already-idle');
      await expect(adapter.terminate()).resolves.toBeUndefined();
    });

    it('exposes the synthetic pid and runs after spawn', async () => {
      const a = new ScriptedCliAdapter({ pid: 7777 });
      a.enqueueResponse('hi');
      await a.sendMessage(userMessage);
      expect(a.isRunning()).toBe(true);
      expect(a.getPid()).toBe(7777);
      expect(a.interrupt().status).toBe('accepted');
    });

    it('defaults to a synthetic pid when none is given', async () => {
      adapter.enqueueResponse('hi');
      await adapter.sendMessage(userMessage);
      expect(adapter.getPid()).toBe(424242);
    });

    it('terminate marks it stopped, clears the pid, and emits exit', async () => {
      adapter.enqueueResponse('hi');
      await adapter.sendMessage(userMessage);
      await adapter.terminate();
      expect(adapter.isRunning()).toBe(false);
      expect(adapter.getPid()).toBeNull();
      expect(adapter.interrupt().status).toBe('already-idle');
      expect(adapter.receipts.ofType('exit')).toHaveLength(1);
      expect(adapter.receipts.ofType('exit')[0].payload).toEqual({ code: 0, signal: null });
    });

    it('reports a healthy scripted status', async () => {
      const status = await adapter.checkStatus();
      expect(status.available).toBe(true);
      expect(status.version).toBe('scripted');
    });

    it('records inputs sent via sendInput', async () => {
      await adapter.sendInput('a typed message');
      expect(adapter.inputs).toEqual([{ message: 'a typed message', attachments: undefined }]);
    });
  });

  describe('receipt synchronisation (no sleeps)', () => {
    it('awaitReceipt resolves for a future receipt', async () => {
      adapter.enqueueTurn(simpleTextTurn('soon'));
      const pending = awaitReceipt(adapter.receipts, byType('complete'), { includePast: false });
      await adapter.sendMessage(userMessage);
      const receipt = await pending;
      expect(receipt.type).toBe('complete');
    });

    it('awaitReceipt resolves immediately for an already-recorded receipt', async () => {
      adapter.enqueueTurn(simpleTextTurn('done'));
      await adapter.sendMessage(userMessage);
      const receipt = await awaitReceipt(adapter.receipts, byType('output'));
      expect(receipt.payload).toBe('done');
    });

    it('awaitReceipt times out when no match arrives', async () => {
      await expect(
        awaitReceipt(adapter.receipts, byType('tool_use'), { includePast: false, timeoutMs: 10 }),
      ).rejects.toThrow(/timed out/);
    });

    it('drainRuntime waits for the in-flight sendMessage turn to finish', async () => {
      adapter.enqueueTurn([
        { kind: 'output', content: 'slow', delayMs: 5 },
        { kind: 'complete', response: { content: 'slow' } },
      ]);
      const turn = adapter.sendMessage(userMessage);
      await drainRuntime(adapter);
      expect(adapter.receipts.ofType('complete')).toHaveLength(1);
      await turn;
    });

    it('drainRuntime tracks a streaming turn (armed eagerly, resolves after consumption)', async () => {
      adapter.enqueueTurn(multiChunkTurn(['x', 'y']));
      const iterator = adapter.sendMessageStream(userMessage); // arms inflight eagerly
      const drained = drainRuntime(adapter);
      // Before consuming, the streaming turn has not completed.
      expect(adapter.receipts.ofType('complete')).toHaveLength(0);
      const chunks: string[] = [];
      for await (const chunk of iterator) chunks.push(chunk);
      await drained; // resolves now that iteration finished
      expect(chunks).toEqual(['x', 'y']);
      expect(adapter.receipts.ofType('complete')).toHaveLength(1);
    });

    it('drainRuntime resolves even if a streaming turn errors', async () => {
      adapter.enqueueTurn([{ kind: 'error', error: 'stream-boom', fail: true }]);
      adapter.on('error', () => { /* swallow so EventEmitter does not throw */ });
      const iterator = adapter.sendMessageStream(userMessage);
      const drained = drainRuntime(adapter);
      await expect((async () => {
        for await (const _ of iterator) { /* consume */ }
      })()).rejects.toThrow('stream-boom');
      await expect(drained).resolves.toBeUndefined();
    });
  });

  describe('ReceiptBus sharing', () => {
    it('records into an externally-provided bus', async () => {
      const bus = new ReceiptBus();
      const a = new ScriptedCliAdapter({ receiptBus: bus });
      a.enqueueResponse('shared');
      await a.sendMessage(userMessage);
      expect(bus.ofType('complete')).toHaveLength(1);
    });
  });
});

describe('ScriptedCliAdapter interrupt/stdin fault modes (Phase 0 injection)', () => {
  const userMsg: CliMessage = { role: 'user', content: 'hi' };

  async function runningAdapter(mode: InterruptFaultMode): Promise<ScriptedCliAdapter> {
    const a = new ScriptedCliAdapter({ interruptFaultMode: mode });
    a.enqueueResponse('hi');
    await a.sendMessage(userMsg);
    return a;
  }

  it('accepted-no-completion: accepted with no completion promise', async () => {
    const a = await runningAdapter('accepted-no-completion');
    const r = a.interrupt();
    expect(r.status).toBe('accepted');
    expect(r.completion).toBeUndefined();
  });

  it('completion-settles: completion resolves to interrupted', async () => {
    const a = await runningAdapter('completion-settles');
    const r = a.interrupt();
    expect(r.status).toBe('accepted');
    await expect(r.completion).resolves.toMatchObject({ status: 'interrupted' });
  });

  it('completion-never-settles: completion promise never resolves', async () => {
    const a = await runningAdapter('completion-never-settles');
    const r = a.interrupt();
    expect(r.completion).toBeInstanceOf(Promise);
    const raced = await Promise.race([
      r.completion!.then(() => 'settled'),
      Promise.resolve('pending'),
    ]);
    expect(raced).toBe('pending');
  });

  it('ignores-sigterm: terminate is a no-op; never exits', async () => {
    const a = await runningAdapter('ignores-sigterm');
    await a.terminate();
    expect(a.isRunning()).toBe(true);
    expect(a.receipts.ofType('exit')).toHaveLength(0);
  });

  it('exits-after-interrupt: emits exit (SIGINT) after interrupt', async () => {
    const a = await runningAdapter('exits-after-interrupt');
    expect(a.interrupt().status).toBe('accepted');
    await Promise.resolve(); // flush queued microtask
    expect(a.isRunning()).toBe(false);
    expect(a.receipts.ofType('exit')).toHaveLength(1);
    expect(a.receipts.ofType('exit')[0].payload).toEqual({ code: 0, signal: 'SIGINT' });
  });

  it('never-exits-after-interrupt: interrupt accepted, terminate is a no-op', async () => {
    const a = await runningAdapter('never-exits-after-interrupt');
    expect(a.interrupt().status).toBe('accepted');
    await a.terminate();
    expect(a.isRunning()).toBe(true);
    expect(a.receipts.ofType('exit')).toHaveLength(0);
  });

  it('wrong-turn-id-interrupt: accepted with a mismatched turnId (§6.1)', async () => {
    const a = await runningAdapter('wrong-turn-id-interrupt');
    const r = a.interrupt();
    expect(r.status).toBe('accepted');
    expect(r.turnId).toBe('mismatched-turn-id');
  });

  it('stdin-drain-never-fires: sendInput records the input but never resolves', async () => {
    const a = await runningAdapter('stdin-drain-never-fires');
    const raced = await Promise.race([
      a.sendInput('msg').then(() => 'resolved'),
      Promise.resolve('pending'),
    ]);
    expect(raced).toBe('pending');
    expect(a.inputs).toEqual([{ message: 'msg', attachments: undefined }]);
  });
});
