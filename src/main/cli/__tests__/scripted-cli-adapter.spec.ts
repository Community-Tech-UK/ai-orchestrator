/**
 * A6 — ScriptedCliAdapter + runtime-receipt helpers.
 *
 * Demonstrates the deterministic test harness: a scripted adapter drives the
 * canonical adapter lifecycle events, and awaitReceipt/drainRuntime let the test
 * block on exactly the events it expects — no `sleep()` anywhere.
 */

import { describe, it, expect } from 'vitest';
import type { CliToolCall } from '../adapters/base-cli-adapter';
import {
  observeAdapterRuntimeEvents,
  type NormalizedAdapterRuntimeEvent,
} from '../../providers/adapter-runtime-event-bridge';
import { ScriptedCliAdapter } from './scripted-cli-adapter';
import { ReceiptRecorder, awaitReceipt, drainRuntime } from './runtime-receipts';

const readTool: CliToolCall = { id: 't1', name: 'read_file', arguments: { path: 'a.ts' } };

describe('ScriptedCliAdapter', () => {
  it('replays a scripted turn as ordered lifecycle receipts', async () => {
    const adapter = new ScriptedCliAdapter({
      turns: [
        [
          { kind: 'status', status: 'thinking' },
          { kind: 'output', content: 'Reading the file…\n' },
          { kind: 'tool_use', toolCall: readTool },
          { kind: 'tool_result', toolCall: { ...readTool, result: 'ok' } },
          { kind: 'output', content: 'Done.' },
          { kind: 'complete' },
          { kind: 'exit', code: 0 },
        ],
      ],
    });
    const recorder = new ReceiptRecorder(adapter);

    const response = await adapter.sendMessage({ role: 'user', content: 'go' });

    expect(recorder.receipts().map((r) => r.type)).toEqual([
      'spawned',
      'status',
      'output',
      'tool_use',
      'tool_result',
      'output',
      'complete',
      'exit',
    ]);
    // Response folds accumulated output + tool calls.
    expect(response.content).toBe('Reading the file…\nDone.');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls?.[0]?.name).toBe('read_file');
    recorder.dispose();
  });

  it('synthesizes a complete event when the script omits one', async () => {
    const adapter = new ScriptedCliAdapter({ turns: [[{ kind: 'output', content: 'hi' }]] });
    const recorder = new ReceiptRecorder(adapter);
    const response = await adapter.sendMessage({ role: 'user', content: 'go' });
    expect(recorder.ofType('complete')).toHaveLength(1);
    expect(response.content).toBe('hi');
  });

  it('replays one turn per call across multiple turns', async () => {
    const adapter = new ScriptedCliAdapter({
      turns: [
        [{ kind: 'output', content: 'turn-1' }, { kind: 'complete' }],
      ],
    });
    adapter.enqueueTurn([{ kind: 'output', content: 'turn-2' }, { kind: 'complete' }]);
    expect(adapter.pendingTurns()).toBe(2);

    const r1 = await adapter.sendMessage({ role: 'user', content: 'a' });
    const r2 = await adapter.sendMessage({ role: 'user', content: 'b' });
    expect(r1.content).toBe('turn-1');
    expect(r2.content).toBe('turn-2');
    expect(adapter.pendingTurns()).toBe(0);
  });

  it('carries usage through on a complete step', async () => {
    const adapter = new ScriptedCliAdapter({
      turns: [[{ kind: 'complete', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }]],
    });
    const response = await adapter.sendMessage({ role: 'user', content: 'go' });
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });
});

describe('runtime-receipt helpers', () => {
  it('awaitReceipt resolves on a predicate-matched event (no sleep)', async () => {
    const adapter = new ScriptedCliAdapter({
      turns: [
        [
          { kind: 'output', content: 'before' },
          { kind: 'tool_use', toolCall: readTool },
          { kind: 'complete' },
        ],
      ],
    });
    const recorder = new ReceiptRecorder(adapter);

    const toolUsePromise = awaitReceipt(
      adapter,
      { type: 'tool_use', predicate: (args) => (args[0] as CliToolCall).name === 'read_file' },
      { recorder },
    );
    await adapter.sendMessage({ role: 'user', content: 'go' });
    const receipt = await toolUsePromise;

    expect(receipt.type).toBe('tool_use');
    expect((receipt.args[0] as CliToolCall).name).toBe('read_file');
    recorder.dispose();
  });

  it('awaitReceipt fast-path finds an already-recorded receipt', async () => {
    const adapter = new ScriptedCliAdapter({ turns: [[{ kind: 'complete' }, { kind: 'exit', code: 0 }]] });
    const recorder = new ReceiptRecorder(adapter);
    await adapter.sendMessage({ role: 'user', content: 'go' });

    // The 'exit' already fired; awaitReceipt must resolve from the recorder log.
    const exit = await awaitReceipt(adapter, 'exit', { recorder, timeoutMs: 100 });
    expect(exit.type).toBe('exit');
    expect(exit.args[0]).toBe(0);
    recorder.dispose();
  });

  it('awaitReceipt rejects with a useful message on timeout', async () => {
    const adapter = new ScriptedCliAdapter();
    const recorder = new ReceiptRecorder(adapter);
    await expect(
      awaitReceipt(adapter, 'exit', { recorder, timeoutMs: 30 }),
    ).rejects.toThrow(/awaitReceipt timed out after 30ms waiting for 'exit'/);
    recorder.dispose();
  });

  it('drainRuntime collects all receipts and resolves on a terminal event', async () => {
    const adapter = new ScriptedCliAdapter({
      turns: [
        [
          { kind: 'output', content: 'a' },
          { kind: 'output', content: 'b' },
          { kind: 'complete' },
          { kind: 'exit', code: 0 },
        ],
      ],
    });
    const recorder = new ReceiptRecorder(adapter);
    const drained = drainRuntime(recorder, { timeoutMs: 1000 });
    await adapter.sendMessage({ role: 'user', content: 'go' });
    const receipts = await drained;

    expect(receipts.map((r) => r.type)).toContain('complete');
    expect(recorder.ofType('output')).toHaveLength(2);
    recorder.dispose();
  });
});

describe('ScriptedCliAdapter drives a real consumer (adapter-runtime-event-bridge)', () => {
  it('normalizes scripted events into provider runtime events deterministically', async () => {
    const adapter = new ScriptedCliAdapter({
      turns: [
        [
          { kind: 'output', content: 'working' },
          { kind: 'tool_use', toolCall: readTool },
          { kind: 'tool_result', toolCall: { ...readTool, result: 'file body' } },
          { kind: 'complete', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.01 } },
        ],
      ],
    });

    const events: NormalizedAdapterRuntimeEvent[] = [];
    const unobserve = observeAdapterRuntimeEvents(adapter, (e) => events.push(e));

    await adapter.sendMessage({ role: 'user', content: 'go' });
    unobserve();

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('tool_use');
    expect(kinds).toContain('tool_result');
    expect(kinds).toContain('complete');

    const toolUse = events.find((e) => e.kind === 'tool_use');
    expect(toolUse).toBeDefined();
    expect((toolUse!.event as { toolName: string }).toolName).toBe('read_file');

    // The bridge lifts usage.totalTokens onto the normalized complete event.
    const complete = events.find((e) => e.kind === 'complete');
    expect(complete).toBeDefined();
    expect((complete!.event as { tokensUsed?: number }).tokensUsed).toBe(150);
    expect((complete!.event as { costUsd?: number }).costUsd).toBe(0.01);
  });
});
