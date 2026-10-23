/** The Electron thread only dispatches requests; all SQLite work stays in a worker. */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { registerCleanup } from '../../util/cleanup-registry';
import { getRtkTrackingDbPath } from './rtk-tracking-reader';
import type { RtkSavingsSummary, RtkCommandRecord } from './rtk-tracking-reader';
import type { SavingsQuery } from './rtk-daily-rollup';

export type RtkWorkerRequest = { id: number } & (
  { method: 'summary'; options: SavingsQuery } |
  { method: 'history'; options: { projectPath?: string; limit?: number } }
);
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

export class RtkTrackingClient {
  private worker: Worker | null = null;
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly createWorker: () => Worker = () => {
    const js = path.join(__dirname, 'rtk-tracking-worker.js');
    const options = { workerData: { dbPathOverride: getRtkTrackingDbPath(),
      rollupCachePath: path.join(app.getPath('userData'), 'cache', 'rtk-daily.db') } };
    return existsSync(js) ? new Worker(js, options)
      : new Worker(path.join(__dirname, 'rtk-tracking-worker.ts'), { ...options, execArgv: ['--import', 'tsx'] });
  }) {}

  getSummary(options: SavingsQuery = {}): Promise<RtkSavingsSummary | null> {
    return this.request('summary', options) as Promise<RtkSavingsSummary | null>;
  }
  getRecentHistory(options: { projectPath?: string; limit?: number } = {}): Promise<RtkCommandRecord[]> {
    return this.request('history', options) as Promise<RtkCommandRecord[]>;
  }

  private request(method: RtkWorkerRequest['method'], options: SavingsQuery | { projectPath?: string; limit?: number }): Promise<unknown> {
    const key = JSON.stringify([method, options]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.pending.size >= 32) return Promise.reject(new Error('RTK analytics is busy; try again shortly'));
    if (!this.worker) {
      const worker = this.createWorker();
      this.worker = worker;
      worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        if (this.pending.size === 0) worker.unref();
      });
      worker.on('error', (error) => { if (this.worker === worker) this.fail(error); });
      worker.on('exit', (code) => {
        if (this.worker === worker) this.fail(new Error(`RTK analytics worker exited (${code})`));
      });
    }
    const worker = this.worker;
    const id = ++this.sequence;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('RTK analytics timed out')), 120_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.ref();
        worker.postMessage({ id, method, options });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.inFlight.set(key, promise);
    void promise.finally(() => this.inFlight.delete(key)).catch(() => undefined);
    return promise;
  }

  private fail(error: Error): void {
    const worker = this.worker;
    this.worker = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.inFlight.clear();
    void worker?.terminate();
  }
  close(): void { this.fail(new Error('RTK analytics closed')); }
}
let instance: RtkTrackingClient | null = null;
let unregisterCleanup: (() => void) | null = null;
export function getRtkTrackingClient(): RtkTrackingClient {
  if (!instance) {
    const client = new RtkTrackingClient();
    instance = client;
    unregisterCleanup = registerCleanup(() => client.close());
  }
  return instance;
}
export function _resetForTesting(): void {
  unregisterCleanup?.(); unregisterCleanup = null;
  instance?.close(); instance = null;
}
