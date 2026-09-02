import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type {
  BackgroundJobLane,
  BackgroundJobRecord,
  LaneInboundMessage,
  LaneGatewayMetrics,
  LaneOutboundMessage,
  LaneProgressEvent,
} from './types';
import type { LaneGateway } from './lane-gateway';

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

interface TransientJobRequest {
  job: BackgroundJobRecord;
  payload: unknown;
  cancelled: boolean;
  resolve: (value: unknown) => void;
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
  transient?: boolean;
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
  private readonly transient: boolean;
  private processHandle: LaneProcessHandle | null = null;
  private readonly stoppingHandles = new WeakSet<LaneProcessHandle>();
  private readonly crashedHandles = new WeakSet<LaneProcessHandle>();
  private readonly exitedHandles = new WeakSet<LaneProcessHandle>();
  private transientShutdown: Promise<void> | null = null;
  private readonly transientJobQueue: TransientJobRequest[] = [];
  private activeTransientJobRequest: TransientJobRequest | null = null;
  private drainingTransientJobQueue = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private transientRestartRequest: TransientJobRequest | null = null;
  private stopped = false;
  private lifecycleGeneration = 0;
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
    this.transient = options.transient === true;
  }

  async start(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.stopped = false;
    if (this.transient) return;
    if (this.transientShutdown) await this.transientShutdown;
    if (this.stopped || this.lifecycleGeneration !== generation) return;
    if (this.processHandle) return;
    if (this.restartTimer) return;
    this.startProcess(false);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.lifecycleGeneration++;
    this.clearRestartTimer();
    this.rejectTransientJobQueue(new Error(`Lane ${this.lane} is stopped`));
    this.rejectProcessStartWaiters(new Error(`Lane ${this.lane} stopped before it became available`));
    if (this.transientShutdown) await this.transientShutdown;
    if (!this.processHandle) {
      if (this.pending.size > 0) {
        this.failAllPending(new Error(`Lane ${this.lane} stopped before completing pending jobs`));
      }
      return;
    }
    const handle = this.processHandle;
    this.stoppingHandles.add(handle);
    this.sendMessageToHandle(handle, { type: 'shutdown' });
    await this.waitForExitBeforeTermination(handle);
    if (this.processHandle === handle) {
      this.processHandle = null;
    }
  }

  async runJob(job: BackgroundJobRecord, payload: unknown): Promise<unknown> {
    if (this.transient) {
      if (this.stopped) throw new Error(`Lane ${this.lane} is stopped`);
      return new Promise((resolve, reject) => {
        this.transientJobQueue.push({ job, payload, cancelled: false, resolve, reject });
        void this.drainTransientJobQueue();
      });
    }

    return this.runJobOnActiveHandle(job, payload, true, this.lifecycleGeneration);
  }

  private async runJobOnActiveHandle(
    job: BackgroundJobRecord,
    payload: unknown,
    explicitlyStart: boolean,
    generation: number,
    transientRequest: TransientJobRequest | null = null,
  ): Promise<unknown> {
    if (transientRequest) this.assertTransientRequestActive(transientRequest, generation);
    if (!this.processHandle) {
      if (explicitlyStart) {
        await this.start();
      } else if (transientRequest) {
        await this.ensureTransientProcess(generation, transientRequest);
      }
    }
    if (transientRequest) this.assertTransientRequestActive(transientRequest, generation);
    if (!this.processHandle) {
      await this.waitForProcessStart();
    }
    if (transientRequest) {
      this.assertTransientRequestActive(transientRequest, generation);
    } else if (!explicitlyStart) {
      this.assertLifecycleActive(generation);
    }
    if (!this.processHandle) {
      throw new Error(`Lane ${this.lane} is not available`);
    }

    const handle = this.processHandle;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { jobId: job.id, resolve, reject, timeout: null };
      this.pending.set(job.id, pending);
      this.armRequestTimeout(pending);
      this.sendMessageToHandle(handle, {
        type: 'run-job',
        jobId: job.id,
        jobType: job.type,
        payload,
      });
    });
  }

  private async drainTransientJobQueue(): Promise<void> {
    if (this.drainingTransientJobQueue) return;
    this.drainingTransientJobQueue = true;
    try {
      while (this.transientJobQueue.length > 0) {
        if (this.stopped) {
          this.rejectTransientJobQueue(new Error(`Lane ${this.lane} is stopped`));
          return;
        }
        const request = this.transientJobQueue.shift();
        if (!request) continue;
        const generation = this.lifecycleGeneration;
        this.activeTransientJobRequest = request;
        try {
          const result = await this.runJobOnActiveHandle(
            request.job, request.payload, false, generation, request,
          );
          request.resolve(result);
        } catch (error) {
          request.reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          if (this.activeTransientJobRequest === request) this.activeTransientJobRequest = null;
        }
      }
    } finally {
      this.drainingTransientJobQueue = false;
      if (this.transientJobQueue.length > 0) {
        void this.drainTransientJobQueue();
      }
    }
  }

  private async ensureTransientProcess(generation: number, request: TransientJobRequest): Promise<void> {
    this.assertTransientRequestActive(request, generation);
    if (this.transientShutdown) {
      await this.transientShutdown;
      this.assertTransientRequestActive(request, generation);
    }
    if (!this.processHandle && !this.restartTimer) {
      if (this.metrics.degraded) {
        this.scheduleRestart(true, request);
      } else {
        this.startProcess(true);
      }
    }
  }

  private assertLifecycleActive(generation: number): void {
    if (this.stopped || this.lifecycleGeneration !== generation) {
      throw new Error(`Lane ${this.lane} is stopped`);
    }
  }

  private assertTransientRequestActive(request: TransientJobRequest, generation: number): void {
    this.assertLifecycleActive(generation);
    if (request.cancelled) throw this.createCancellationError(request.job.id);
  }

  private rejectTransientJobQueue(error: Error): void {
    for (const request of this.transientJobQueue.splice(0)) {
      request.reject(error);
    }
  }

  async cancelJob(jobId: string): Promise<void> {
    if (this.transient) {
      const queuedIndex = this.transientJobQueue.findIndex((request) => request.job.id === jobId);
      if (queuedIndex !== -1) {
        const [request] = this.transientJobQueue.splice(queuedIndex, 1);
        request.cancelled = true;
        this.cancelTransientRestartTimer(request);
        request.reject(this.createCancellationError(jobId));
        return;
      }

      const activeRequest = this.activeTransientJobRequest;
      if (activeRequest?.job.id === jobId && !this.pending.has(jobId)) {
        activeRequest.cancelled = true;
        this.cancelTransientRestartTimer(activeRequest);
        this.rejectProcessStartWaiters(this.createCancellationError(jobId));
        const activeHandle = this.processHandle;
        if (activeHandle) await this.releaseTransientHandle(activeHandle);
        return;
      }
    }

    const handle = this.processHandle;
    if (!handle) return;
    this.sendMessageToHandle(handle, { type: 'cancel-job', jobId });
  }

  private createCancellationError(jobId: string): Error {
    return new Error(`Lane ${this.lane} job ${jobId} cancelled`);
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

  private startProcess(transientDemanded: boolean): void {
    if (this.stopped) return;
    try {
      const handle = this.processFactory?.() ?? this.createDefaultProcess();
      handle.on('message', (message) => {
        this.handleMessage(handle, message as LaneProcessOutboundMessage);
      });
      handle.on('error', (error) => {
        this.handleCrash(handle, error instanceof Error ? error : new Error(String(error)));
      });
      handle.on('exit', (code) => {
        this.exitedHandles.add(handle);
        if (code !== 0 || this.transient) {
          this.handleCrash(handle, new Error(`Lane ${this.lane} exited with code ${String(code)}`));
        }
      });
      this.processHandle = handle;
      this.metrics.degraded = false;
      this.resolveProcessStartWaiters();
    } catch (error) {
      this.markDegraded(error instanceof Error ? error.message : String(error));
      this.scheduleRestart(transientDemanded, this.activeTransientJobRequest);
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

  private sendMessageToHandle(handle: LaneProcessHandle, message: LaneInboundMessage): void {
    if (handle.postMessage) {
      handle.postMessage(message);
      return;
    }
    handle.send?.(message);
  }

  private handleMessage(handle: LaneProcessHandle, message: LaneProcessOutboundMessage): void {
    if (this.processHandle !== handle) return;
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

    if (message.type === 'worker-event') {
      this.emit('worker-event', message.message);
      return;
    }

    if (message.type === 'job-succeeded') {
      const pending = this.pending.get(message.jobId);
      if (!pending) return;
      this.metrics.processed++;
      this.completePendingAfterTerminal(handle, pending, () => pending.resolve(message.result));
      return;
    }

    if (message.type === 'job-failed') {
      const pending = this.pending.get(message.jobId);
      if (!pending) return;
      this.metrics.failed++;
      this.completePendingAfterTerminal(
        handle,
        pending,
        () => pending.reject(new Error(message.errorMessage)),
      );
      return;
    }

    const pending = this.pending.get(message.jobId);
    if (!pending) return;
    this.metrics.failed++;
    this.completePendingAfterTerminal(
      handle,
      pending,
      () => pending.reject(new Error(`Lane ${this.lane} job ${message.jobId} cancelled`)),
    );
  }

  private completePendingAfterTerminal(
    handle: LaneProcessHandle,
    pending: PendingRequest,
    settle: () => void,
  ): void {
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pending.delete(pending.jobId);
    if (!this.transient) {
      settle();
      return;
    }
    void this.releaseTransientHandle(handle).then(settle, (error: unknown) => {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async releaseTransientHandle(handle: LaneProcessHandle): Promise<void> {
    if (this.transientShutdown) {
      await this.transientShutdown;
      return;
    }
    this.stoppingHandles.add(handle);
    this.sendMessageToHandle(handle, { type: 'shutdown' });
    const shutdown = this.waitForExitBeforeTermination(handle);
    this.transientShutdown = shutdown;
    try {
      await shutdown;
    } finally {
      if (this.processHandle === handle) {
        this.processHandle = null;
      }
      if (this.transientShutdown === shutdown) {
        this.transientShutdown = null;
      }
    }
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
    if (this.transient && !this.exitedHandles.has(handle)) void this.releaseTransientHandle(handle);
    this.processHandle = null;
    this.markDegraded(error.message);
    if (!this.transient) this.scheduleRestart();
  }

  private scheduleRestart(
    transientDemanded = false, transientRequest: TransientJobRequest | null = null,
  ): boolean {
    if (this.transient && !transientDemanded) {
      return false;
    }
    if (this.stopped || this.metrics.restarted >= this.maxRestarts) {
      this.rejectProcessStartWaiters(new Error(`Lane ${this.lane} is not available`));
      return false;
    }
    const delay = this.restartBackoffMs * 2 ** this.metrics.restarted;
    this.metrics.restarted++;
    this.clearRestartTimer();
    this.transientRestartRequest = this.transient ? transientRequest : null;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.transientRestartRequest = null;
      if (!this.stopped) {
        this.startProcess(transientDemanded);
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
    this.transientRestartRequest = null;
  }

  private cancelTransientRestartTimer(request: TransientJobRequest): void {
    if (!this.restartTimer || this.transientRestartRequest !== request) return;
    this.clearRestartTimer();
    this.metrics.restarted = Math.max(0, this.metrics.restarted - 1);
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
      if (this.transient) {
        this.beginTimedOutTransientRetirement(handle);
      } else {
        void this.terminateTimedOutHandle(handle);
      }
    }
    if (!this.transient) this.scheduleRestart();
  }

  private refreshRequestTimeouts(): void {
    for (const pending of this.pending.values()) {
      this.armRequestTimeout(pending);
    }
  }

  private terminateTimedOutHandle(handle: LaneProcessHandle): Promise<void> {
    return this.terminateHandleWithin(handle, this.shutdownTimeoutMs);
  }

  private beginTimedOutTransientRetirement(handle: LaneProcessHandle): void {
    if (this.transientShutdown) return;
    const retirement = this.terminateTimedOutHandle(handle);
    this.transientShutdown = retirement;
    const clear = (): void => {
      if (this.transientShutdown === retirement) this.transientShutdown = null;
    };
    void retirement.then(clear, clear);
  }

  private async waitForExitBeforeTermination(handle: LaneProcessHandle): Promise<void> {
    if (this.exitedHandles.has(handle)) {
      this.failPendingStoppedJobs();
      return;
    }
    const gracefulExitBudget = Math.floor(this.shutdownTimeoutMs / 2);
    const terminationBudget = this.shutdownTimeoutMs - gracefulExitBudget;
    const exited = await this.waitForHandleExit(handle, gracefulExitBudget);
    if (!exited) {
      await this.terminateHandleWithin(handle, terminationBudget);
    }

    this.failPendingStoppedJobs();
  }

  private waitForHandleExit(handle: LaneProcessHandle, timeoutMs: number): Promise<boolean> {
    if (this.exitedHandles.has(handle)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onExit = (): void => {
        clearTimeout(timeout);
        resolve(true);
      };
      const timeout = setTimeout(() => {
        handle.removeListener('exit', onExit);
        resolve(false);
      }, timeoutMs);
      handle.once('exit', onExit);
      if (typeof timeout.unref === 'function') timeout.unref();
    });
  }

  private async terminateHandleWithin(
    handle: LaneProcessHandle,
    timeoutMs: number,
  ): Promise<void> {
    if (!handle.terminate) {
      handle.kill?.();
      return;
    }
    const terminated = Promise.resolve().then(() => handle.terminate?.()).then(
      () => 'terminated' as const,
      () => 'failed' as const,
    );
    let timeout: NodeJS.Timeout | null = null;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), timeoutMs);
      if (typeof timeout.unref === 'function') timeout.unref();
    });
    const result = await Promise.race([terminated, timedOut]);
    if (timeout) clearTimeout(timeout);
    if (result !== 'terminated') handle.kill?.();
  }

  private failPendingStoppedJobs(): void {
    if (this.pending.size > 0) {
      this.failAllPending(new Error(`Lane ${this.lane} stopped before completing pending jobs`));
    }
  }
}
