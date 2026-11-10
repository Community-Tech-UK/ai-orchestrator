import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter } from './codex-cli-adapter';
import type { CodexAppServerRuntimeClient, CodexAppServerThreadRuntime } from './codex/app-server-thread-runtime';
import type { AppServerMethod, AppServerNotification, AppServerNotificationHandler, AppServerRequestParams, AppServerResponseResult } from './codex/app-server-types';

vi.mock('./codex/app-server-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('./codex/app-server-client')>(),
  terminateProcessTree: vi.fn(),
}));

function createHarness(timeout?: number) {
  const adapter = new CodexCliAdapter({ timeout });
  const subscribers = new Set<AppServerNotificationHandler>();
  const outputs: { type: string; content: string }[] = [];
  const statuses: string[] = [];
  const internals = adapter as unknown as {
    appServerRuntime: CodexAppServerThreadRuntime;
    handleIdleAppServerNotification(notification: AppServerNotification): void;
  };
  const client: CodexAppServerRuntimeClient = {
    exitPromise: new Promise<void>(() => { /* The external transport remains alive. */ }),
    request: async <M extends AppServerMethod>(_method: M, _params: AppServerRequestParams<M>) => (
      { turn: { id: 'turn-1', status: 'inProgress' } } as AppServerResponseResult<M>
    ),
    subscribeNotifications(handler: AppServerNotificationHandler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    isRunning: () => true,
  };
  Object.assign(adapter, { appServerClient: client, appServerThreadId: 'thread-1', useAppServer: true, isSpawned: true });
  internals.appServerRuntime.attach(client,
    { threadId: 'thread-1', resumeCursor: null, resumeProof: null },
    (notification) => internals.handleIdleAppServerNotification(notification));
  adapter.on('output', (output) => outputs.push(output));
  adapter.on('status', (status) => statuses.push(status));
  return {
    adapter, outputs, statuses,
    active: () => internals.appServerRuntime.hasActiveTurn(),
    emit(method: AppServerNotification['method'], params: Record<string, unknown>) {
      for (const subscriber of [...subscribers]) subscriber({ method, params: { threadId: 'thread-1', ...params } });
    },
    compact(method: 'item/started' | 'item/completed') {
      this.emit(method, { turnId: 'turn-1', item: { type: 'contextCompaction', id: 'compact-1' } });
    },
  };
}

describe('Codex compaction notification watchdog', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['harness', 'provider'])('keeps a quiet %s compaction busy for 35 minutes and completes normally', async (origin) => {
    vi.useFakeTimers();
    const h = createHarness();
    let send: Promise<void> | undefined;
    try {
      if (origin === 'harness') {
        send = h.adapter.sendInput('Read this.');
        await vi.advanceTimersByTimeAsync(0);
      } else {
        h.emit('turn/started', { turn: { id: 'turn-1', status: 'inProgress' } });
      }
      h.compact('item/started');
      await vi.advanceTimersByTimeAsync(35 * 60_000);
      expect(h.active()).toBe(true);
      expect(h.statuses).not.toContain('idle');
      expect(h.outputs.filter((output) => output.type === 'error')).toEqual([]);
      h.compact('item/completed');
      h.emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
      await vi.advanceTimersByTimeAsync(0);
      await send;
      expect(h.active()).toBe(false);
      expect(h.statuses.filter((status) => status === 'idle')).toEqual(['idle']);
    } finally {
      await h.adapter.terminate(false);
      await send?.catch(() => undefined);
    }
  });

  it('still times out a quiet compaction at its finite 40-minute limit', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    try {
      h.emit('turn/started', { turn: { id: 'turn-1', status: 'inProgress' } });
      h.compact('item/started');
      await vi.advanceTimersByTimeAsync(40 * 60_000 - 1);
      expect(h.active()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.active()).toBe(false);
      expect(h.outputs.filter((output) => output.type === 'error')).toHaveLength(1);
      expect(h.outputs.at(-1)?.content).toContain('no notifications received for 2400000ms');
    } finally {
      await h.adapter.terminate(false);
    }
  });

  it('restores the ordinary 15-minute silence limit after compaction ends', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    try {
      h.emit('turn/started', { turn: { id: 'turn-1', status: 'inProgress' } });
      h.compact('item/started');
      await vi.advanceTimersByTimeAsync(1_000);
      h.compact('item/completed');
      await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
      expect(h.active()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.active()).toBe(false);
      expect(h.outputs.filter((output) => output.type === 'error')).toHaveLength(1);
    } finally {
      await h.adapter.terminate(false);
    }
  });

  it('honours an explicit shorter timeout during compaction', async () => {
    vi.useFakeTimers();
    const h = createHarness(60_000);
    try {
      h.emit('turn/started', { turn: { id: 'turn-1', status: 'inProgress' } });
      h.compact('item/started');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.active()).toBe(false);
      expect(h.outputs.filter((output) => output.type === 'error')).toHaveLength(1);
    } finally {
      await h.adapter.terminate(false);
    }
  });
});

describe('Codex loop provider compaction', () => {
  it('counts current contextCompaction completed once for the active turn through the shared notification hook', () => {
    const adapter = new CodexCliAdapter();
    const internals = adapter as unknown as {
      appServerThreadId: string;
      contextOuterSendId: string;
      appServerRuntime: { getCurrentTurnId(): string | null; hasActiveTurn(): boolean };
      handleIdleAppServerNotification(notification: { method: string; params: Record<string, unknown> }): void;
    };
    internals.appServerThreadId = 'test-thread'; internals.contextOuterSendId = 'send-1';
    vi.spyOn(internals.appServerRuntime, 'getCurrentTurnId').mockReturnValue('test-turn');
    vi.spyOn(internals.appServerRuntime, 'hasActiveTurn').mockReturnValue(true);
    const params = { threadId: 'test-thread', turnId: 'test-turn', item: { type: 'contextCompaction', id: 'compact-item' } };
    internals.handleIdleAppServerNotification({ method: 'item/started', params });
    expect(adapter.getTurnCompaction()).toEqual({ count: 0 });
    internals.handleIdleAppServerNotification({ method: 'item/completed', params });
    expect(adapter.getTurnCompaction()).toEqual({ count: 1 });
    internals.handleIdleAppServerNotification({ method: 'item/completed', params });
    internals.handleIdleAppServerNotification({ method: 'thread/compacted', params: { threadId: 'test-thread', turnId: 'test-turn' } });
    internals.handleIdleAppServerNotification({ method: 'item/completed', params: { ...params, threadId: 'different-thread' } });
    expect(adapter.getTurnCompaction()).toEqual({ count: 1 });
    internals.contextOuterSendId = 'send-2';
    expect(adapter.getTurnCompaction()).toEqual({ count: 0 });
  });
});
