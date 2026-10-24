import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter } from './codex-cli-adapter';
import type { AppServerNotification } from './codex/app-server-types';
import type { CliAsyncWorkEvent } from './claude-cli-async-work';
import { getLogger } from '../../logging/logger';

vi.mock('./codex/app-server-client', async (original) => ({
  ...await original<typeof import('./codex/app-server-client')>(), terminateProcessTree: vi.fn(),
}));
const adapters: CodexCliAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.terminate(false); vi.restoreAllMocks(); });
function harness() {
  const adapter = new CodexCliAdapter();
  adapters.push(adapter);
  const subscribers = new Set<(notification: AppServerNotification) => void>();
  let exit!: () => void;
  const terminal = { processId: 'process-1', itemId: 'item-1', command: 'sleep 300', cwd: '/workspace' };
  const request = vi.fn().mockResolvedValue({ data: [terminal] });
  const client = {
    request, exitPromise: new Promise<void>((resolve) => { exit = resolve; }),
    isRunning: () => true,
    close: vi.fn(async () => { exit(); }),
    subscribeNotifications(handler: (notification: AppServerNotification) => void) {
      subscribers.add(handler); return () => subscribers.delete(handler);
    },
  };
  const internal = adapter as unknown as {
    ensureAppServerRuntimeAttached(): void;
    appServerClient: typeof client; appServerThreadId: string; useAppServer: boolean; isSpawned: boolean;
    handleIdleAppServerNotification(notification: AppServerNotification): void;
  };
  Object.assign(internal, { appServerClient: client, appServerThreadId: 'root', useAppServer: true, isSpawned: true });
  internal.ensureAppServerRuntimeAttached();
  const events: CliAsyncWorkEvent[] = [];
  const output: string[] = [];
  adapter.on('async_work', (event) => events.push(event));
  adapter.on('output', (message) => output.push(message.content));
  const emit = (method: AppServerNotification['method'], params: Record<string, unknown>) => {
    const notification = { method, params: { threadId: 'root', ...params } };
    // Exercise the same connection callback as production initialization.
    internal.handleIdleAppServerNotification(notification);
  };
  return { adapter, events, output, emit, request, exit };
}
describe('Codex background-work adapter integration', () => {
  it('reports an unfinished command at turn completion and refreshes the real terminal list', async () => {
    const h = harness();
    h.emit('item/started', { item: { id: 'item-1', type: 'commandExecution', command: 'sleep 300' } });
    h.emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await expect(h.adapter.refreshBackgroundWork()).resolves.toBe(true);
    expect(h.request).toHaveBeenCalledWith('thread/backgroundTerminals/list', expect.objectContaining({ threadId: 'root' }), expect.any(Number));
    expect(h.events).toContainEqual({ phase: 'snapshot', work: [{ workId: 'codex-term:process-1', kind: 'background-shell' }] });
    expect(h.adapter.getAdapterCapabilities().supportsAsyncWorkAutoResume).toBe(false);
  });
  it('logs and publishes one plain transcript notice when terminating live terminals', async () => {
    const warn = vi.spyOn(getLogger('CodexCliAdapter'), 'warn');
    const h = harness();
    await h.adapter.refreshBackgroundWork();
    await h.adapter.terminate(false);
    expect(warn).toHaveBeenCalledWith('Stopping session also stops background commands', expect.objectContaining({ count: 1 }));
    expect(h.output.filter((line) => line.includes('also stopped 1 background command'))).toEqual(['Closing this session also stopped 1 background command (sleep 300).']);
    expect(h.events.at(-1)).toEqual({ phase: 'snapshot', work: [] });
    expect(h.events.filter((event) => event.phase === 'terminal')).toEqual([]);
  });
  it('waits for the stopped-work notice to be saved before completing shutdown', async () => {
    const h = harness();
    await h.adapter.refreshBackgroundWork();
    let saved!: () => void;
    const reporter = vi.fn(() => new Promise<void>((resolve) => { saved = resolve; }));
    h.adapter.setBackgroundWorkTerminationReporter(reporter);
    let terminated = false;
    const stop = h.adapter.terminate(false).then(() => { terminated = true; });
    await vi.waitFor(() => expect(reporter).toHaveBeenCalledTimes(1));
    expect(terminated).toBe(false);
    saved();
    await stop;
    expect(terminated).toBe(true);
  });

  it('still stops the adapter if transcript reporting fails', async () => {
    const h = harness();
    await h.adapter.refreshBackgroundWork();
    h.adapter.setBackgroundWorkTerminationReporter(() => { throw new Error('transcript unavailable'); });
    await expect(h.adapter.terminate(false)).resolves.toBeUndefined();
    expect(h.adapter.isAppServerMode()).toBe(false);
    expect(h.events.at(-1)).toEqual({ phase: 'snapshot', work: [] });
  });

  it('emits command completion between turns and forgets work on process exit', async () => {
    const h = harness();
    await h.adapter.refreshBackgroundWork();
    h.emit('item/completed', { item: { id: 'item-1', type: 'commandExecution', status: 'completed' } });
    expect(h.events).toContainEqual(expect.objectContaining({ phase: 'terminal', detail: 'sleep 300', workId: 'codex-term:process-1' }));
    h.exit();
    await Promise.resolve();
    expect(h.events.at(-1)).toEqual({ phase: 'snapshot', work: [] });
  });
});
