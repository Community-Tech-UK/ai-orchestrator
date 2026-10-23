import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }));
vi.mock('../rtk-tracking-reader', () => ({ getRtkTrackingDbPath: () => '/unused/history.db' }));
import { RtkTrackingClient } from '../rtk-tracking-client';

class FakeWorker extends EventEmitter {
  messages: { id: number; method: string; options: unknown }[] = [];
  postMessage(message: { id: number; method: string; options: unknown }): void { this.messages.push(message); }
  unref = vi.fn();
  ref = vi.fn();
  terminate = vi.fn(async () => 0);
}
const clients: RtkTrackingClient[] = [];
afterEach(() => { for (const client of clients) client.close(); clients.length = 0; vi.useRealTimers(); });
function setup() {
  const workers: FakeWorker[] = [];
  const client = new RtkTrackingClient(() => {
    const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker;
  });
  clients.push(client);
  return { client, workers };
}

describe('RTK worker query client', () => {
  it('returns asynchronously, coalesces duplicate refreshes and preserves request routing', async () => {
    const { client, workers } = setup();
    const first = client.getSummary({ sinceMs: 1 });
    expect(client.getSummary({ sinceMs: 1 })).toBe(first);
    const history = client.getRecentHistory({ limit: 2 });
    expect(workers[0].messages).toHaveLength(2);
    await new Promise<void>(resolve => setTimeout(resolve, 0)); // main event loop remains runnable
    workers[0].emit('message', { id: workers[0].messages[1].id, result: [] });
    workers[0].emit('message', { id: workers[0].messages[0].id, result: { commands: 42 } });
    expect(await history).toEqual([]);
    expect(await first).toEqual({ commands: 42 });
    expect(workers[0].unref).toHaveBeenCalled();
  });

  it('rejects outstanding work on a clean unexpected exit and starts a fresh worker', async () => {
    const { client, workers } = setup();
    const result = client.getSummary();
    const rejection = expect(result).rejects.toThrow('worker exited (0)');
    workers[0].emit('exit', 0);
    await rejection;
    const next = client.getSummary();
    expect(workers).toHaveLength(2);
    workers[1].emit('message', { id: workers[1].messages[0].id, result: null });
    expect(await next).toBeNull();
  });

  it('terminates a stalled worker and rejects queued requests on timeout', async () => {
    vi.useFakeTimers();
    const { client, workers } = setup();
    const result = client.getSummary();
    const rejection = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
    expect(workers[0].terminate).toHaveBeenCalled();
  });
});
