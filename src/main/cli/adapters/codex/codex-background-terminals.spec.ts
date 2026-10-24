import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexBackgroundTerminalTracker, listBackgroundTerminals } from './codex-background-terminals';
import type { AppServerNotification } from './app-server-types';
import type { CodexAppServerRuntimeClient } from './app-server-thread-runtime';
import type { CliAsyncWorkEvent } from '../claude-cli-async-work';

const terminal = { itemId: 'item-1', processId: 'process-1', command: 'sleep 300', cwd: '/workspace' };
function harness() {
  const request = vi.fn().mockResolvedValue({ data: [terminal], nextCursor: null });
  const client = { request } as unknown as CodexAppServerRuntimeClient;
  const events: CliAsyncWorkEvent[] = [];
  const stopped = vi.fn();
  const tracker = new CodexBackgroundTerminalTracker((event) => events.push(event), stopped);
  tracker.bind(client, 'root');
  const observe = (method: AppServerNotification['method'], params: Record<string, unknown> = {}) => tracker.observe({ method, params: { threadId: 'root', ...params } });
  return { tracker, request, events, stopped, observe, client };
}
afterEach(() => vi.useRealTimers());

describe('Codex background terminals', () => {
  it('pages the live terminal list', async () => {
    const h = harness();
    h.request.mockResolvedValueOnce({ data: [terminal], nextCursor: 'next' }).mockResolvedValueOnce({ data: [{ ...terminal, processId: 'process-2' }], nextCursor: null });
    expect(await listBackgroundTerminals(h.client, 'root')).toHaveLength(2);
    expect(h.request.mock.calls[1][1]).toMatchObject({ threadId: 'root', cursor: 'next' });
    h.tracker.reset();
  });
  it('publishes snapshots and one completion with command detail when a terminal disappears', async () => {
    const h = harness();
    expect(await h.tracker.refresh()).toBe(true);
    expect(h.events.at(-1)).toEqual({ phase: 'snapshot', work: [{ workId: 'codex-term:process-1', kind: 'background-shell' }] });
    h.request.mockResolvedValue({ data: [], nextCursor: null });
    expect(await h.tracker.refresh()).toBe(false);
    await h.tracker.refresh();
    expect(h.events.filter((e) => e.phase === 'terminal')).toEqual([{ phase: 'terminal', workId: 'codex-term:process-1', kind: 'background-shell', status: 'completed', detail: 'sleep 300' }]);
    h.tracker.reset();
  });
  it('protects unfinished command items synchronously at turn end and falls back on unsupported servers', async () => {
    const h = harness();
    h.request.mockRejectedValue(Object.assign(new Error('Method not found'), { rpcCode: -32601 }));
    h.observe('item/started', { item: { id: 'item-1', type: 'commandExecution', command: 'sleep 300' } });
    h.observe('turn/completed', { turn: { id: 'turn-1' } });
    expect(h.events.at(-1)).toMatchObject({ phase: 'snapshot', work: [{ workId: 'codex-item:item-1' }] });
    expect(await h.tracker.refresh()).toBe(true);
    const calls = h.request.mock.calls.length;
    expect(await h.tracker.refresh()).toBe(true);
    expect(h.request).toHaveBeenCalledTimes(calls);
    h.observe('item/completed', { item: { id: 'item-1', type: 'commandExecution', status: 'completed' } });
    expect(await h.tracker.refresh()).toBe(false);
    expect(h.events.filter((e) => e.phase === 'terminal')).toHaveLength(1);
    h.tracker.reset();
  });
  it('retains known work on refresh errors and stops polling on reset', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.tracker.refresh();
    h.request.mockRejectedValue(new Error('connection reset'));
    await expect(h.tracker.refresh()).rejects.toThrow('connection reset');
    expect(h.tracker.hasWork()).toBe(true);
    h.request.mockResolvedValue({ data: [terminal] });
    await vi.advanceTimersByTimeAsync(60_000);
    const calls = h.request.mock.calls.length;
    h.tracker.reset();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.request).toHaveBeenCalledTimes(calls);
    expect(h.events.at(-1)).toEqual({ phase: 'snapshot', work: [] });
  });
  it('replaces provisional item ids without falsely completing the command and deduplicates notification/poll', async () => {
    const h = harness();
    h.observe('item/started', { item: { id: 'item-1', type: 'commandExecution', command: terminal.command } });
    h.observe('turn/completed');
    await h.tracker.refresh();
    expect(h.events.filter((e) => e.phase === 'terminal')).toEqual([]);
    h.observe('item/completed', { item: { id: 'item-1', type: 'commandExecution', status: 'completed' } });
    h.request.mockResolvedValue({ data: [] });
    await h.tracker.refresh();
    expect(h.events.filter((e) => e.phase === 'terminal')).toEqual([expect.objectContaining({ workId: 'codex-term:process-1' })]);
    h.tracker.reset();
  });
  it('ignores child thread items and drops late refresh results after exit', async () => {
    const h = harness();
    h.observe('item/started', { threadId: 'child', item: { id: 'child', type: 'commandExecution' } });
    h.observe('turn/completed');
    expect(h.request).not.toHaveBeenCalled();
    let resolve!: (value: unknown) => void;
    h.request.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const refresh = h.tracker.refresh();
    h.tracker.reset();
    resolve({ data: [terminal] });
    await refresh;
    expect(h.tracker.hasWork()).toBe(false);
    expect(h.events.at(-1)).toEqual({ phase: 'snapshot', work: [] });
  });
  it('rejects malformed pages instead of clearing protection and stops polling after completion', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.tracker.refresh();
    h.request.mockResolvedValue({});
    await expect(h.tracker.refresh()).rejects.toThrow();
    expect(h.tracker.hasWork()).toBe(true);
    h.request.mockResolvedValue({ data: [] });
    await h.tracker.refresh();
    const calls = h.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.request).toHaveBeenCalledTimes(calls);
    h.tracker.reset();
  });
  it('does not request a continuation when a final shutdown refresh discovers completion', async () => {
    const h = harness();
    await h.tracker.refresh();
    h.request.mockResolvedValue({ data: [] });
    await h.tracker.refresh(true);
    expect(h.events.filter((e) => e.phase === 'terminal')).toEqual([expect.objectContaining({ continueOnCompletion: false })]);
    h.tracker.reset();
  });

  it('reports stopped commands once and clears work without scheduling completion', async () => {
    const h = harness();
    await h.tracker.refresh();
    h.tracker.reportStopped();
    h.tracker.reportStopped();
    expect(h.stopped).toHaveBeenCalledExactlyOnceWith(1, ['sleep 300']);
    expect(h.events.filter((e) => e.phase === 'terminal')).toEqual([]);
    expect(h.tracker.hasWork()).toBe(false);
  });
});
