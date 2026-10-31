import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter } from './codex-cli-adapter';
import { AppServerClientBase, type AppServerClient } from './codex/app-server-client';
import type { AppServerMethod, AppServerNotification, AppServerRequestParams, AppServerResponseResult } from './codex/app-server-types';
import type { CliResponse } from './base-cli-adapter';

class Wire extends AppServerClientBase {
  rpc: (method: string, params: unknown) => unknown = method => {
    if (method === 'turn/start') {
      this.feed([started('first')]);
      return { turn: { id: 'first', status: 'inProgress' } };
    }
    return {};
  };
  override readonly request = vi.fn(async <M extends AppServerMethod>(
    method: M, params: AppServerRequestParams<M>,
  ): Promise<AppServerResponseResult<M>> => await this.rpc(method, params) as AppServerResponseResult<M>);
  constructor() { super(process.cwd(), 'direct'); }
  protected sendMessage(): void { throw new Error('Unexpected transport write'); }
  async close(): Promise<void> { this.handleExit(); }
  feed(events: AppServerNotification[]): void {
    // Exercise the actual socket chunk parser and synchronous notification hub.
    this.handleChunk(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  }
}

class Adapter extends CodexCliAdapter {
  reconcile: () => Promise<void> = async () => undefined;
  connect(wire: Wire): void {
    this.appServerClient = wire as unknown as AppServerClient;
    this.appServerThreadId = 'fixture-thread';
    this.useAppServer = this.isSpawned = true;
    this.appServerRuntime.attach(wire, { threadId: 'fixture-thread', resumeCursor: null, resumeProof: null },
      event => this.handleIdleAppServerNotification(event));
  }
  protected override async reconcileChildRollouts(): Promise<void> { await this.reconcile(); }
}

function event(method: AppServerNotification['method'], turnId: string, fields: Record<string, unknown> = {}): AppServerNotification {
  return { method, params: { threadId: 'fixture-thread', turnId, ...fields } };
}
function started(id: string): AppServerNotification {
  return event('turn/started', id, { turn: { id, status: 'inProgress' } });
}
function finished(id: string, cumulative = 12): AppServerNotification[] {
  return [
    event('item/completed', id, { item: { id: `${id}-tool`, type: 'commandExecution',
      command: 'fixture command', status: 'completed', exitCode: 0, aggregatedOutput: `${id} tool result` } }),
    usage(id, cumulative),
    event('item/completed', id, { item: { id: `${id}-answer`, type: 'agentMessage', phase: 'final_answer', text: id } }),
    event('turn/completed', id, { turn: { id, status: 'completed', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } }),
  ];
}
function usage(id: string, total: number): AppServerNotification {
  return event('thread/tokenUsage/updated', id, { tokenUsage: {
    total: { inputTokens: total * 5 / 6, outputTokens: total / 6, totalTokens: total },
    last: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, modelContextWindow: 100,
  } });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const adapters: Adapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.terminate(false); });

function harness() {
  const wire = new Wire();
  const adapter = new Adapter();
  adapters.push(adapter);
  adapter.connect(wire);
  const replies: CliResponse[] = [];
  const order: string[] = [];
  const output: { type: string; content: string; metadata?: Record<string, unknown> }[] = [];
  adapter.on('complete', (reply: CliResponse) => { replies.push(reply); order.push(reply.content); });
  adapter.on('status', status => order.push(status));
  adapter.on('output', message => output.push(message));
  return { wire, adapter, replies, order, output };
}

describe('Codex native turn capture handoff', () => {
  it.each([
    ['harness', false], ['provider', false], ['harness', true], ['provider', true],
  ] as const)('retains complete batched turns after %s capture (publication blocked: %s)', async (origin, blocked) => {
    const h = harness();
    const publishing = deferred();
    const entered = deferred();
    let calls = 0;
    h.adapter.reconcile = async () => {
      if (calls++ === 0 && blocked) { entered.resolve(); await publishing.promise; }
    };
    const send = origin === 'harness' ? h.adapter.sendInput('Read the fixture') : Promise.resolve();
    if (origin === 'harness') await vi.waitFor(() => expect(h.adapter.hasActiveTurn()).toBe(true));
    else h.wire.feed([started('first')]);
    h.wire.feed(finished('first'));
    if (blocked) await entered.promise;
    h.wire.feed([started('second'), ...finished('second', 24), started('third'), ...finished('third', 36)]);
    if (blocked) {
      expect(h.replies).toEqual([]);
      expect(h.output.filter(message => message.type === 'assistant')).toEqual([]);
    }
    publishing.resolve();
    await send;
    await vi.waitFor(() => expect(h.order.at(-1)).toBe('idle'));
    expect(h.replies.map(reply => reply.content)).toEqual(['first', 'second', 'third']);
    expect(h.replies.map(reply => reply.usage)).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({
      inputTokens: 10, outputTokens: 2, totalTokens: 12,
    })));
    expect(h.replies.map(reply => reply.toolCalls?.map(tool => tool.result)))
      .toEqual([['first tool result'], ['second tool result'], ['third tool result']]);
    expect(h.order.indexOf('idle')).toBeGreaterThan(h.order.indexOf('third'));
    expect(h.adapter.hasActiveTurn()).toBe(false);
    expect(h.output.filter(message => message.type === 'error')).toEqual([]);
    expect(h.wire.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(origin === 'harness' ? 1 : 0);
  });

  it.each(['harness', 'provider'] as const)('delays later inline compaction until %s reply publication', async origin => {
    const h = harness();
    const publishing = deferred();
    const entered = deferred();
    let calls = 0;
    h.adapter.reconcile = async () => { if (calls++ === 0) { entered.resolve(); await publishing.promise; } };
    const send = origin === 'harness' ? h.adapter.sendInput('Read the fixture') : Promise.resolve();
    if (origin === 'harness') await vi.waitFor(() => expect(h.adapter.hasActiveTurn()).toBe(true));
    else h.wire.feed([started('first')]);
    h.wire.feed(finished('first'));
    await entered.promise;
    const compact = { id: 'inline-compact', type: 'contextCompaction' };
    h.wire.feed([started('second'),
      event('item/started', 'second', { item: compact }), event('item/completed', 'second', { item: compact }),
      ...finished('second', 24)]);
    expect(h.output.some(message => message.metadata?.['threadCompacted'])).toBe(false);
    expect(h.replies).toEqual([]);
    publishing.resolve();
    await send;
    await vi.waitFor(() => expect(h.replies).toHaveLength(2));
    expect(h.replies.map(reply => reply.content)).toEqual(['first', 'second']);
    expect(h.replies.map(reply => reply.usage?.totalTokens)).toEqual([12, 12]);
    expect(h.output.filter(message => message.metadata?.['threadCompacted'])).toHaveLength(1);
  });

  it('waits for publication then joins the next native turn without starting another', async () => {
    const h = harness();
    const publishing = deferred();
    const entered = deferred();
    let calls = 0;
    h.adapter.reconcile = async () => { if (calls++ === 0) { entered.resolve(); await publishing.promise; } };
    h.wire.feed([started('first'), ...finished('first')]);
    await entered.promise;
    h.wire.feed([started('second')]);
    const send = h.adapter.sendInput('Also check the second fixture');
    let settled = false;
    void send.then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.wire.request.mock.calls.map(([method]) => method)).not.toContain('turn/start');
    expect(settled).toBe(false);
    publishing.resolve();
    await vi.waitFor(() => expect(h.wire.request).toHaveBeenCalledWith('turn/steer', expect.objectContaining({ expectedTurnId: 'second' })));
    expect(settled).toBe(false);
    h.wire.feed(finished('second', 24));
    await send;
    expect(h.replies.map(reply => reply.content)).toEqual(['first', 'second']);
    expect(h.order.indexOf('idle')).toBeGreaterThan(h.order.indexOf('second'));
    expect(h.wire.request.mock.calls.map(([method]) => method)).not.toContain('turn/start');
  });

  it('keeps trailing usage with the unpublished response', async () => {
    const h = harness();
    h.wire.feed([started('first'), ...finished('first'), usage('first', 18)]);
    await vi.waitFor(() => expect(h.replies).toHaveLength(1));
    expect(h.replies[0].usage?.totalTokens).toBe(18);
    expect(h.order.at(-1)).toBe('idle');
  });

  it.each(['harness', 'provider'] as const)('keeps busy after a joined %s send while a successor publishes', async origin => {
    const h = harness();
    const publishing = deferred();
    const entered = deferred();
    let calls = 0;
    h.adapter.reconcile = async () => { if (calls++ === 1) { entered.resolve(); await publishing.promise; } };
    if (origin === 'provider') h.wire.feed([started('first')]);
    const send = h.adapter.sendInput('Read the fixture');
    await vi.waitFor(() => expect(h.wire.request.mock.calls.map(([method]) => method))
      .toContain(origin === 'provider' ? 'turn/steer' : 'turn/start'));
    h.wire.feed([...finished('first'), started('second'), ...finished('second', 24), started('third')]);
    await entered.promise;
    if (origin === 'provider') await send;
    expect(h.replies.map(reply => reply.content)).toEqual(['first']);
    expect(h.order).not.toContain('idle');
    expect(h.adapter.hasActiveTurn()).toBe(true);
    // A manual compact here must not replace the native third turn awaiting capture.
    await expect(h.adapter.compactContext()).resolves.toBe(false);
    expect(h.wire.request.mock.calls.map(([method]) => method)).not.toContain('thread/compact/start');
    publishing.resolve();
    await vi.waitFor(() => expect(h.replies).toHaveLength(2));
    h.wire.feed(finished('third', 36));
    await send;
    await vi.waitFor(() => expect(h.order.at(-1)).toBe('idle'));
    expect(h.replies.map(reply => reply.content)).toEqual(['first', 'second', 'third']);
    expect(h.replies.map(reply => reply.usage?.totalTokens)).toEqual([12, 12, 12]);
  });

  it.each(['harness', 'provider'] as const)('keeps reused child usage in its native root turn after %s capture', async origin => {
    const h = harness();
    const child = (id: string, total: number): AppServerNotification[] => [
      { method: 'turn/started', params: { threadId: 'fixture-child', turn: { id, status: 'inProgress' } } },
      { method: 'thread/tokenUsage/updated', params: { threadId: 'fixture-child', turnId: id, tokenUsage: {
        total: { inputTokens: total * 5 / 6, outputTokens: total / 6, totalTokens: total },
        last: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      } } },
      { method: 'turn/completed', params: { threadId: 'fixture-child', turn: {
        id, status: 'completed', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      } } },
    ];
    const send = origin === 'harness' ? h.adapter.sendInput('Read the fixture') : Promise.resolve();
    if (origin === 'harness') await vi.waitFor(() => expect(h.adapter.hasActiveTurn()).toBe(true));
    else h.wire.feed([started('first')]);
    h.wire.feed([
      { method: 'thread/started', params: { thread: { id: 'fixture-child' } } },
      ...child('child-first', 6), ...finished('first'),
      started('second'), ...child('child-second', 12), ...finished('second', 24),
    ]);
    await send;
    await vi.waitFor(() => expect(h.order.at(-1)).toBe('idle'));
    expect(h.replies.map(reply => reply.content)).toEqual(['first', 'second']);
    expect(h.replies.map(reply => reply.usage?.totalTokens)).toEqual([18, 18]);
    expect(h.adapter.hasActiveTurn()).toBe(false);
  });

  it.each(['harness', 'provider'] as const)('defers legacy untagged usage after %s capture', async origin => {
    const h = harness();
    const send = origin === 'harness' ? h.adapter.sendInput('Read the fixture') : Promise.resolve();
    if (origin === 'harness') await vi.waitFor(() => expect(h.adapter.hasActiveTurn()).toBe(true));
    else h.wire.feed([started('first')]);
    const events = [...finished('first'), started('second'), ...finished('second', 24)];
    for (const notification of events) {
      if (notification.method === 'thread/tokenUsage/updated') delete notification.params['turnId'];
    }
    h.wire.feed(events);
    await send;
    await vi.waitFor(() => expect(h.order.at(-1)).toBe('idle'));
    expect(h.replies.map(reply => reply.usage?.totalTokens)).toEqual([12, 12]);
  });

  it('drops queued continuations on termination during publication', async () => {
    const h = harness();
    const publishing = deferred();
    const entered = deferred();
    h.adapter.reconcile = async () => { entered.resolve(); await publishing.promise; };
    h.wire.feed([started('first'), ...finished('first')]);
    await entered.promise;
    h.wire.feed([started('second'), ...finished('second', 24)]);
    await h.adapter.terminate(false);
    publishing.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.replies.map(reply => reply.content)).not.toContain('second');
    expect(h.adapter.hasActiveTurn()).toBe(false);
    expect(h.adapter.isRunning()).toBe(false);
  });
});
