import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type {
  BackgroundJobLane,
  BackgroundJobRecord,
  LaneInboundMessage,
  LaneOutboundMessage,
} from './types';
import type { LaneGateway } from './lane-gateway';
import type {
  LaneGatewayMetrics,
  LaneProgressEvent,
} from './types';

type LaneProcessOutboundMessage =
  | LaneOutboundMessage
  | { type: 'degraded'; reason: string };

export type LaneProcessHandle = EventEmitter & {
  postMessage?: (message: LaneInboundMessage) => void;
  send?: (message: LaneInboundMessage) => void;
  kill?: () => void;
  terminate?: () => Promise<unknown>;
};

interface PendingRequest {
  jobId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
}

interface ProcessStartWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface ProcessLaneGatewayOptions {
  lane: BackgroundJobLane;
  entrypoint: string;
  processFactory?: () => LaneProcessHandle;
  requestTimeoutMs?: number;
  restartBackoffMs?: number;
  maxRestarts?: number;
  shutdownTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export class ProcessLaneGateway extends EventEmitter implements LaneGateway {
  readonly lane: BackgroundJobLane;

  private readonly entrypoint: string;
  private readonly processFactory?: () => LaneProcessHandle;
  private readonly requestTimeoutMs: number;
  private readonly restartBackoffMs: number;
  private readonly maxRestarts: number;
  private readonly shutdownTimeoutMs: number;
  private processHandle: LaneProcessHandle | null = null;
  private readonly stoppingHandles = new WeakSet<LaneProcessHandle>();
  private readonly crashedHandles = new WeakSet<LaneProcessHandle>();
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private pending = new Map<string, PendingRequest>();
  private processStartWaiters: ProcessStartWaiter[] = [];
  private metrics = {
    degraded: false,
    processed: 0,
    failed: 0,
    restarted: 0,
    lastHeartbeatAt: null as number | null,
    lastError: null as string | null,
  };

  constructor(options: ProcessLaneGatewayOptions) {
    super();
    this.lane = options.lane;
    this.entrypoint = options.entrypoint;
    this.processFactory = options.processFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.processHandle) return;
    this.stopped = false;
    if (this.restartTimer) return;
    this.startProcess();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRestartTimer();
    this.rejectProcessStartWaiters(new Error(`Lane ${this.lane} stopped before it became available`));
    if (!this.processHandle) {
      if (this.pending.size > 0) {
        this.failAllPending(new Error(`Lane ${this.lane} stopped before completing pending jobs`));
      }
      return;
    }
    const handle = this.processHandle;
    this.stoppingHandles.add(handle);
    this.sendMessage({ type: 'shutdown' });
    this.processHandle = null;
    await this.waitForExitBeforeTermination(handle);
  }

  async runJob(job: BackgroundJobRecord, payload: unknown): Promise<unknown> {
    if (!this.processHandle) {
      await this.start();
    }
    if (!this.processHandle) {
      await this.waitForProcessStart();
    }
    if (!this.processHandle) {
      throw new Error(`Lane ${this.lane} is not available`);
    }

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { jobId: job.id, resolve, reject, timeout: null };
      this.pending.set(job.id, pending);
      this.armRequestTimeout(pending);
      this.sendMessage({
        type: 'run-job',
        jobId: job.id,
        jobType: job.type,
        payload,
      });
    });
  }

  async cancelJob(jobId: string): Promise<void> {
    if (!this.processHandle) return;
    this.sendMessage({ type: 'cancel-job', jobId });
  }

  getMetrics(): LaneGatewayMetrics {
    return {
      degraded: this.metrics.degraded,
      inFlight: this.pending.size,
      processed: this.metrics.processed,
      failed: this.metrics.failed,
      restarted: this.metrics.restarted,
      lastHeartbeatAt: this.metrics.lastHeartbeatAt,
      lastError: this.metrics.lastError,
    };
  }

  private startProcess(): void {
    if (this.stopped) return;
    try {
      const handle = this.processFactory?.() ?? this.createDefaultProcess();
      handle.on('message', (message) => this.handleMessage(message as LaneProcessOutboundMessage));
      handle.on('error', (error) => {
        this.handleCrash(handle, error instanceof Error ? error : new Error(String(error)));
      });
      handle.on('exit', (code) => {
        if (code !== 0) {
          this.handleCrash(handle, new Error(`Lane ${this.lane} exited with code ${String(code)}`));
        }
      });
      this.processHandle = handle;
      this.metrics.degraded = false;
      this.resolveProcessStartWaiters();
    } catch (error) {
      this.markDegraded(error instanceof Error ? error.message : String(error));
      this.scheduleRestart();
    }
  }

  private createDefaultProcess(): LaneProcessHandle {
    const electronProcess = this.tryCreateUtilityProcess();
    if (electronProcess) return electronProcess;

    const entrypoint = this.resolveEntrypoint(this.entrypoint);
    return fork(entrypoint, [], {
      execArgv: entrypoint.endsWith('.ts') ? ['--import', 'tsx'] : [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }) as LaneProcessHandle;
  }

  private tryCreateUtilityProcess(): LaneProcessHandle | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as {
        app?: { isPackaged?: boolean };
        utilityProcess?: {
          fork: (modulePath: string, args?: string[], options?: Record<string, unknown>) => LaneProcessHandle;
        };
      };
      if (!electron.utilityProcess?.fork) return null;
      const entrypoint = this.resolveEntrypoint(this.entrypoint);
      if (!this.isUtilityProcessCompatibleEntrypoint(entrypoint)) return null;
      return electron.utilityProcess.fork(entrypoint, [], {
        serviceName: `${this.lane}-lane`,
      });
    } catch {
      return null;
    }
  }

  private isUtilityProcessCompatibleEntrypoint(entrypoint: string): boolean {
    const extension = path.extname(entrypoint).toLowerCase();
    return extension === '.js' || extension === '.mjs' || extension === '.cjs';
  }

  private resolveEntrypoint(entrypoint: string): string {
    if (existsSync(entrypoint)) return entrypoint;
    const tsEntrypoint = entrypoint.replace(/\.js$/, '.ts');
    if (existsSync(tsEntrypoint)) return tsEntrypoint;
    const localJs = path.join(__dirname, path.basename(entrypoint));
    if (existsSync(localJs)) return localJs;
    const localTs = localJs.replace(/\.js$/, '.ts');
    if (existsSync(localTs)) return localTs;
    return entrypoint;
  }

  private sendMessage(message: LaneInboundMessage): void {
    if (!this.processHandle) return;
    if (this.processHandle.postMessage) {
      this.processHandle.postMessage(message);
      return;
    }
    this.processHandle.send?.(message);
  }

  private handleMessage(message: LaneProcessOutboundMessage): void {
    if (message.type === 'ready') {
      this.metrics.degraded = false;
      return;
    }
    if (message.type === 'job-started') {
      this.refreshRequestTimeouts();
      return;
    }
    if (message.type === 'job-progress') {
      this.refreshRequestTimeouts();
      this.emit('progress', {
        jobId: message.jobId,
        lane: this.lane,
        progress: message.progress,
      } satisfies LaneProgressEvent);
      return;
    }
    if (message.type === 'heartbeat') {
      const timestamp = message.timestamp;
      this.metrics.lastHeartbeatAt = timestamp;
      this.refreshRequestTimeouts();
      this.emit('heartbeat', { lane: this.lane, timestamp });
      return;
    }
    if (message.type === 'degraded') {
      this.markDegraded(message.reason);
      return;
    }

    if (message.type === 'job-succeeded') {
      const pending = this.pending.get(message.jobId);
      if (!pending) return;
      if (pending.timeout) clearTimeout(pending.timeout);
      this.pending.delete(message.jobId);
      this.metrics.processed++;
      pending.resolve(message.result);
      return;
    }

    if (message.type === 'job-failed') {
      const pending = this.pending.get(message.jobId);
      if (!pending) return;
      if (pending.timeout) clearTimeout(pending.timeout);
      this.pending.delete(message.jobId);
      this.metrics.failed++;
      pending.reject(new Error(message.errorMessage));
      return;
    }

    const pending = this.pending.get(message.jobId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pending.delete(message.jobId);
    this.metrics.failed++;
    pending.reject(new Error(`Lane ${this.lane} job ${message.jobId} cancelled`));
  }

  private handleCrash(handle: LaneProcessHandle, error: Error): void {
    if (
      this.stoppingHandles.has(handle)
      || this.crashedHandles.has(handle)
      || this.processHandle !== handle
    ) {
      return;
    }

    this.crashedHandles.add(handle);
    this.failAllPending(error);
    this.processHandle = null;
    this.markDegraded(error.message);
    this.scheduleRestart();
  }

  private scheduleRestart(): boolean {
    if (this.stopped || this.metrics.restarted >= this.maxRestarts) {
      this.rejectProcessStartWaiters(new Error(`Lane ${this.lane} is not available`));
      return false;
    }
    const delay = this.restartBackoffMs * 2 ** this.metrics.restarted;
    this.metrics.restarted++;
    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) {
        this.startProcess();
      }
    }, delay);
    if (typeof this.restartTimer.unref === 'function') {
      this.restartTimer.unref();
    }
    return true;
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private markDegraded(reason: string): void {
    this.metrics.degraded = true;
    this.metrics.lastError = reason;
    this.emit('degraded', { lane: this.lane, reason });
  }

  private waitForProcessStart(): Promise<void> {
    if (this.processHandle) {
      return Promise.resolve();
    }
    if (this.stopped) {
      return Promise.reject(new Error(`Lane ${this.lane} is stopped`));
    }
    if (this.metrics.degraded && !this.restartTimer) {
      return Promise.reject(new Error(`Lane ${this.lane} is not available`));
    }
    return new Promise((resolve, reject) => {
      this.processStartWaiters.push({ resolve, reject });
    });
  }

  private resolveProcessStartWaiters(): void {
    const waiters = this.processStartWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private rejectProcessStartWaiters(error: Error): void {
    const waiters = this.processStartWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private armRequestTimeout(pending: PendingRequest): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      pending.timeout = null;
      return;
    }
    pending.timeout = setTimeout(() => {
      if (this.pending.get(pending.jobId) !== pending) {
        return;
      }
      pending.timeout = null;
      this.handleRequestTimeout(pending);
    }, this.requestTimeoutMs);
    if (typeof pending.timeout.unref === 'function') {
      pending.timeout.unref();
    }
  }

  private handleRequestTimeout(pending: PendingRequest): void {
    if (this.pending.get(pending.jobId) !== pending) return;

    const error = new Error(`Lane ${this.lane} request timed out`);
    const handle = this.processHandle;
    this.failAllPending(error);
    this.markDegraded(error.message);
    if (handle) {
      this.crashedHandles.add(handle);
      this.processHandle = null;
      void this.terminateTimedOutHandle(handle);
    }
    this.scheduleRestart();
  }

  private refreshRequestTimeouts(): void {
    for (const pending of this.pending.values()) {
      this.armRequestTimeout(pending);
    }
  }

  private async terminateTimedOutHandle(handle: LaneProcessHandle): Promise<void> {
    if (handle.terminate) {
      await handle.terminate().catch(() => undefined);
      return;
    }
    handle.kill?.();
  }

  private async waitForExitBeforeTermination(handle: LaneProcessHandle): Promise<void> {
    let timeout: NodeJS.Timeout | null = null;
    const exited = new Promise<'exit'>((resolve) => {
      handle.once('exit', () => resolve('exit'));
    });
    const timedOut = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), this.shutdownTimeoutMs);
      if (typeof timeout.unref === 'function') {
        timeout.unref();
      }
    });

    const result = await Promise.race([exited, timedOut]);
    if (timeout) {
      clearTimeout(timeout);
    }

    if (result === 'timeout') {
      if (handle.terminate) {
        await handle.terminate().catch(() => undefined);
      } else {
        handle.kill?.();
      }
    }

    if (this.pending.size > 0) {
      this.failAllPending(new Error(`Lane ${this.lane} stopped before completing pending jobs`));
    }
  }
}
