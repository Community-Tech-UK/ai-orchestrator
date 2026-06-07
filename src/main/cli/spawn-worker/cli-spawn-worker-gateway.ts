import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { getLogger } from '../../logging/logger';
import { killProcessGroup } from '../adapters/base-cli-process-utils';
import type {
  SpawnWorkerInboundMsg,
  SpawnWorkerOutboundMsg,
  SpawnWorkerSignal,
} from './cli-spawn-worker-protocol';

const logger = getLogger('CliSpawnWorkerGateway');
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const RESTART_BACKOFF_MS = 2_000;
const MAX_RESTART_ATTEMPTS = 3;

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface CliSpawnWorkerLike extends EventEmitter {
  postMessage(msg: SpawnWorkerInboundMsg): void;
  terminate(): Promise<number>;
}

export interface SpawnInstanceRequest {
  instanceId: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  streamIdleTimeoutMs?: number;
  closeStdin?: boolean;
}

export interface CliSpawnWorkerInstanceEvents {
  spawned?: (pid: number) => void;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  exited?: (code: number | null, signal: string | null) => void;
  streamIdle?: (timeoutMs: number) => void;
  epipe?: (pipe: 'stdin' | 'stdout') => void;
}

export interface CliSpawnGatewayPort {
  registerInstance(instanceId: string, handler: CliSpawnWorkerInstanceEvents): void;
  unregisterInstance(instanceId: string): void;
  spawnInstance(request: SpawnInstanceRequest): Promise<{ pid: number }>;
  writeStdin(instanceId: string, data: string, options?: { closeAfterWrite?: boolean }): Promise<void>;
  sendSignal(instanceId: string, signal: NodeJS.Signals): void;
  terminate(instanceId: string, graceful: boolean): Promise<void>;
}

export interface CliSpawnWorkerGatewayOptions {
  rpcTimeoutMs?: number;
  workerFactory?: () => CliSpawnWorkerLike;
}

function makeWorker(): CliSpawnWorkerLike {
  const jsEntry = path.join(__dirname, 'cli-spawn-worker-main.js');
  if (existsSync(jsEntry)) {
    return new Worker(jsEntry) as CliSpawnWorkerLike;
  }
  const tsEntry = path.join(__dirname, 'cli-spawn-worker-main.ts');
  return new Worker(tsEntry, {
    execArgv: ['--import', 'tsx'],
  }) as CliSpawnWorkerLike;
}

export class CliSpawnWorkerGateway implements CliSpawnGatewayPort {
  private worker: CliSpawnWorkerLike | null = null;
  private rpcId = 0;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly handlers = new Map<string, CliSpawnWorkerInstanceEvents>();
  private readonly liveInstancePids = new Map<string, number>();
  private readonly rpcTimeoutMs: number;
  private readonly workerFactory: () => CliSpawnWorkerLike;
  private restartAttempts = 0;
  private shuttingDown = false;
  private readonly stdinChains = new Map<string, Promise<void>>();

  constructor(options: CliSpawnWorkerGatewayOptions = {}) {
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.workerFactory = options.workerFactory ?? makeWorker;
    this.startWorker();
  }

  registerInstance(instanceId: string, handler: CliSpawnWorkerInstanceEvents): void {
    this.handlers.set(instanceId, handler);
  }

  unregisterInstance(instanceId: string): void {
    this.handlers.delete(instanceId);
    this.liveInstancePids.delete(instanceId);
    this.stdinChains.delete(instanceId);
  }

  async spawnInstance(request: SpawnInstanceRequest): Promise<{ pid: number }> {
    const result = await this.postRpc({
      type: 'spawn',
      id: this.nextId(),
      ...request,
    });
    const pid = typeof (result as { pid?: unknown } | null)?.pid === 'number'
      ? (result as { pid: number }).pid
      : 0;
    return { pid };
  }

  writeStdin(instanceId: string, data: string, options: { closeAfterWrite?: boolean } = {}): Promise<void> {
    const postWrite = () =>
      this.postRpc({
        type: 'stdin-write',
        id: this.nextId(),
        instanceId,
        data,
        closeAfterWrite: options.closeAfterWrite,
      }).then(() => undefined);
    const prior = this.stdinChains.get(instanceId);
    const next = prior ? prior.then(postWrite) : postWrite();
    this.stdinChains.set(instanceId, next.catch(() => undefined));
    return next;
  }

  sendSignal(instanceId: string, signal: NodeJS.Signals): void {
    this.worker?.postMessage({
      type: 'signal',
      instanceId,
      signal: signal as SpawnWorkerSignal,
    });
  }

  async terminate(instanceId: string, graceful: boolean): Promise<void> {
    await this.postRpc({
      type: 'terminate',
      id: this.nextId(),
      instanceId,
      graceful,
    });
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    this.failAllPending(new Error('CLI spawn worker shutting down'));
    if (!this.worker) return;
    try {
      await this.postRpc({ type: 'shutdown', id: this.nextId() });
    } catch {
      // best-effort shutdown
    }
    await this.worker.terminate().catch(() => 0);
    this.worker = null;
  }

  private nextId(): number {
    return ++this.rpcId;
  }

  private startWorker(): void {
    if (this.worker) return;
    try {
      const worker = this.workerFactory();
      worker.on('message', (msg: SpawnWorkerOutboundMsg) => this.handleMessage(msg));
      worker.on('error', (err) => this.handleWorkerError(err));
      worker.on('exit', (code) => {
        if (code !== 0 && !this.shuttingDown) {
          this.handleWorkerError(new Error(`CLI spawn worker exited with code ${code}`));
        }
      });
      this.worker = worker;
    } catch (err) {
      this.handleWorkerError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleMessage(msg: SpawnWorkerOutboundMsg): void {
    switch (msg.type) {
      case 'ready':
        return;
      case 'rpc-response':
        this.handleRpcResponse(msg);
        return;
      case 'spawned':
        this.liveInstancePids.set(msg.instanceId, msg.pid);
        this.handlers.get(msg.instanceId)?.spawned?.(msg.pid);
        return;
      case 'stdout-chunk':
        this.handlers.get(msg.instanceId)?.stdout?.(msg.chunk);
        return;
      case 'stderr-chunk':
        this.handlers.get(msg.instanceId)?.stderr?.(msg.chunk);
        return;
      case 'exited':
        this.liveInstancePids.delete(msg.instanceId);
        this.handlers.get(msg.instanceId)?.exited?.(msg.code, msg.signal);
        return;
      case 'stream-idle':
        if (this.liveInstancePids.has(msg.instanceId)) {
          this.handlers.get(msg.instanceId)?.streamIdle?.(msg.timeoutMs);
        }
        return;
      case 'epipe':
        this.handlers.get(msg.instanceId)?.epipe?.(msg.pipe);
    }
  }

  private handleRpcResponse(msg: Extract<SpawnWorkerOutboundMsg, { type: 'rpc-response' }>): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error));
      return;
    }
    pending.resolve(msg.result ?? null);
  }

  private handleWorkerError(err: Error): void {
    this.failAllPending(err);
    for (const pid of this.liveInstancePids.values()) {
      killProcessGroup(pid, 'SIGKILL');
    }
    this.liveInstancePids.clear();
    this.worker = null;
    if (this.shuttingDown) return;
    if (this.restartAttempts < MAX_RESTART_ATTEMPTS) {
      this.restartAttempts++;
      const timer = setTimeout(() => this.startWorker(), RESTART_BACKOFF_MS);
      timer.unref?.();
      return;
    }
    logger.error('CLI spawn worker exceeded restart attempts', err);
  }

  private failAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private postRpc(msg: SpawnWorkerInboundMsg & { id: number }): Promise<unknown> {
    if (!this.worker) {
      return Promise.reject(new Error('CLI spawn worker unavailable'));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`CLI spawn worker RPC timed out after ${this.rpcTimeoutMs}ms`));
      }, this.rpcTimeoutMs);
      timeout.unref?.();
      this.pending.set(msg.id, { resolve, reject, timeout });
      try {
        this.worker!.postMessage(msg);
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(msg.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

let gateway: CliSpawnWorkerGateway | null = null;

export function getCliSpawnWorkerGateway(): CliSpawnWorkerGateway {
  gateway ??= new CliSpawnWorkerGateway();
  return gateway;
}

export async function shutdownCliSpawnWorkerGateway(): Promise<void> {
  if (!gateway) return;
  await gateway.close();
  gateway = null;
}
