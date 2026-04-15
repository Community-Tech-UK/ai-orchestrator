import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import { reportCapabilities } from './capability-reporter';
import { DiscoveryClient } from './discovery-client';
import {
  LocalInstanceManager,
  type SpawnParams
} from './local-instance-manager';
import { nextReconnectDelayMs, RECONNECT_CONFIG } from './reconnect-backoff';
import type { WorkerConfig } from './worker-config';
import { persistConfig } from './worker-config';
import type { WorkerNodeCapabilities } from '../shared/types/worker-node.types';
import type { FileAttachment } from '../shared/types/instance.types';
import type {
  FsReadDirectoryParams,
  FsReadFileParams,
  FsSearchParams,
  FsStatParams,
  FsUnwatchParams,
  FsWatchParams,
  FsWriteFileParams
} from '../shared/types/remote-fs.types';
import {
  COORDINATOR_TO_NODE,
  NODE_TO_COORDINATOR,
  RPC_ERROR_CODES
} from '../main/remote-node/worker-node-rpc';
import type { EnrollmentResult } from '../main/remote-node/worker-node-rpc';
import {
  NodeFilesystemHandler,
  FsRpcError
} from '../main/remote-node/node-filesystem-handler';
import { SyncHandler } from './sync-handler';
import type {
  SyncScanParams,
  SyncBlockSigParams,
  SyncComputeDeltaParams,
  SyncApplyDeltaParams,
  SyncDeleteFileParams
} from '../shared/types/sync.types';

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.orchestrator',
  'worker-node.json'
);

interface RpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Worker node agent — connects to coordinator, handles RPC commands,
 * manages local CLI instances, sends heartbeats.
 */
export class WorkerAgent extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly instanceManager: LocalInstanceManager;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private capabilities: WorkerNodeCapabilities | null = null;
  private isShuttingDown = false;
  private connecting = false;
  private reconnectAttempt = 0;
  private connectedAt = 0;
  private pendingRegistrationId: string | number | null = null;
  private discoveryClient: DiscoveryClient | null = null;
  private fsHandler: NodeFilesystemHandler | null = null;
  private syncHandler: SyncHandler | null = null;

  // Output batching
  private outputBuffer: { instanceId: string; message: unknown }[] = [];
  private outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly OUTPUT_BATCH_INTERVAL_MS = 50;
  private static readonly OUTPUT_BATCH_MAX_SIZE = 10;

  // Critical message queue — buffers state changes, exits, and permission requests
  // that must not be silently dropped when the WebSocket is temporarily unavailable.
  private criticalMessageQueue: RpcMessage[] = [];
  private static readonly CRITICAL_QUEUE_MAX_SIZE = 100;

  // Monotonic sequence counter for critical messages. Allows the coordinator to
  // detect and discard out-of-order state updates after reconnection.
  private criticalSeq = 0;

  constructor(private readonly config: WorkerConfig) {
    super();
    this.instanceManager = new LocalInstanceManager(
      config.workingDirectories,
      config.maxConcurrentInstances
    );
    this.wireInstanceEvents();
  }

  async connect(): Promise<void> {
    if (this.connecting) return; // Prevent concurrent connect() calls
    this.connecting = true;
    this.isShuttingDown = false;

    try {
      this.capabilities = await reportCapabilities(
        this.config.workingDirectories,
        this.config.maxConcurrentInstances
      );
      this.fsHandler = new NodeFilesystemHandler(
        this.config.workingDirectories
      );

      // Resolve coordinator URL — prefer explicit config, fall back to mDNS.
      let coordinatorUrl = this.config.coordinatorUrl;
      if (!coordinatorUrl) {
        const discovery = new DiscoveryClient();
        const found = await discovery.discover(this.config.namespace, 10_000);
        if (!found) {
          console.warn(
            `mDNS discovery found no coordinator for namespace "${this.config.namespace}" — will retry`
          );
          this.startContinuousDiscovery();
          this.scheduleReconnect();
          return;
        }
        coordinatorUrl = `ws://${found.host}:${found.port}`;
      }

      const token = this.config.nodeToken ?? this.config.authToken;

      await new Promise<void>((resolve) => {
        const ws = new WebSocket(coordinatorUrl as string, {
          headers: { Authorization: `Bearer ${token}` }
        });

        ws.on('open', () => {
          this.ws = ws;
          this.connectedAt = Date.now();
          this.reconnectAttempt = 0;
          console.log(`Connected to coordinator at ${coordinatorUrl}`);
          this.sendRegistration();
          this.flushCriticalQueue(); // Deliver any queued state changes from while disconnected
          this.startHeartbeat();
          this.startContinuousDiscovery();
          resolve();
        });

        ws.on('message', (data: Buffer | string) => {
          this.handleMessage(data.toString());
        });

        ws.on('close', () => {
          this.stopHeartbeat();
          this.ws = null;
          if (!this.isShuttingDown) {
            this.scheduleReconnect();
          }
        });

        ws.on('error', (err) => {
          if (!this.ws) {
            // Initial connection failed — let the close handler trigger reconnect.
            console.warn(
              `Connection failed: ${err instanceof Error ? err.message : err}`
            );
            resolve();
          } else {
            this.emit('error', err);
          }
        });
      });
    } finally {
      this.connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.stopHeartbeat();
    this.stopContinuousDiscovery();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.flushOutputBuffer();
    await this.instanceManager.terminateAll();
    this.fsHandler?.cleanupAllWatchers();
    if (this.ws) {
      this.ws.close(1000, 'Worker shutting down');
      this.ws = null;
    }
  }

  // -- Registration & heartbeat -----------------------------------------------

  /** Exposed for testing. */
  buildRegistrationMessage(): RpcMessage {
    const id = `reg-${Date.now()}`;
    this.pendingRegistrationId = id;
    return {
      jsonrpc: '2.0',
      id,
      method: NODE_TO_COORDINATOR.REGISTER,
      params: {
        nodeId: this.config.nodeId,
        name: this.config.name,
        capabilities: this.capabilities,
        token: this.config.nodeToken ?? this.config.authToken
      }
    };
  }

  private sendRegistration(): void {
    this.send(this.buildRegistrationMessage());
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      // Refresh capabilities (memory changes over time)
      this.capabilities = await reportCapabilities(
        this.config.workingDirectories,
        this.config.maxConcurrentInstances
      );
      this.send({
        jsonrpc: '2.0',
        method: NODE_TO_COORDINATOR.HEARTBEAT,
        params: {
          nodeId: this.config.nodeId,
          capabilities: this.capabilities,
          activeInstances: this.instanceManager.getInstanceCount(),
          token: this.config.nodeToken ?? this.config.authToken
        }
      });
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown) return;

    // Don't stack multiple reconnect timers
    if (this.reconnectTimer) return;

    if (
      this.connectedAt > 0 &&
      Date.now() - this.connectedAt > RECONNECT_CONFIG.stableConnectionResetMs
    ) {
      this.reconnectAttempt = 0;
    }

    const delay = nextReconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt++;
    console.log(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.connect();
      } catch {
        // connect() failed — close handler schedules next retry
      }
    }, delay);
  }

  // -- Continuous discovery ----------------------------------------------------

  /**
   * Keep mDNS browser running so the worker detects coordinator restarts
   * or IP changes. Only used when coordinatorUrl is not explicitly set.
   * Reuses the existing DiscoveryClient if already running.
   */
  private startContinuousDiscovery(): void {
    if (this.config.coordinatorUrl) return; // explicit URL — skip mDNS
    if (this.discoveryClient) return; // already running

    this.discoveryClient = new DiscoveryClient();
    this.discoveryClient.startContinuous(
      this.config.namespace,
      (coordinator) => {
        // Coordinator re-appeared or changed IP — reconnect if we're disconnected
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          console.log(
            `Coordinator re-discovered at ${coordinator.host}:${coordinator.port}, reconnecting...`
          );
          this.scheduleReconnect();
        }
      },
      (name) => {
        console.warn(`Coordinator ${name} disappeared from mDNS`);
      }
    );
  }

  private stopContinuousDiscovery(): void {
    this.discoveryClient?.stopContinuous();
    this.discoveryClient = null;
  }

  // -- Message handling -------------------------------------------------------

  private handleMessage(raw: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(raw) as RpcMessage;
    } catch {
      console.error('Invalid JSON from coordinator:', raw.slice(0, 200));
      return;
    }

    // Response to one of our requests
    if (msg.result !== undefined || msg.error !== undefined) {
      // Enrollment token is only issued on first registration. Subsequent
      // reconnects reuse the persisted nodeToken, and the coordinator
      // responds with { ok: true } — no new token is issued.
      if (
        msg.id !== undefined &&
        msg.id === this.pendingRegistrationId &&
        msg.result !== null &&
        typeof msg.result === 'object'
      ) {
        const enrollment = msg.result as EnrollmentResult;
        if (enrollment.token) {
          this.config.nodeToken = enrollment.token;
          persistConfig(DEFAULT_CONFIG_PATH, this.config);
          this.pendingRegistrationId = null;
        }
      }
      return;
    }

    // RPC request from coordinator
    if (msg.method && msg.id !== undefined) {
      this.handleRpcRequest(msg);
    }
  }

  private async handleRpcRequest(msg: RpcMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;
      switch (msg.method) {
        case COORDINATOR_TO_NODE.INSTANCE_SPAWN:
          await this.instanceManager.spawn(params as unknown as SpawnParams);
          result = { instanceId: params['instanceId'] };
          break;
        case COORDINATOR_TO_NODE.INSTANCE_SEND_INPUT: {
          const attachments = params['attachments'] as
            | FileAttachment[]
            | undefined;
          console.log('[WorkerAgent] INSTANCE_SEND_INPUT received', {
            instanceId: params['instanceId'],
            messageLength: (params['message'] as string)?.length,
            attachmentsCount: attachments?.length ?? 0,
            attachmentNames: attachments?.map((a) => a.name)
          });
          await this.instanceManager.sendInput(
            params['instanceId'] as string,
            params['message'] as string,
            attachments
          );
          result = { ok: true };
          break;
        }
        case COORDINATOR_TO_NODE.INSTANCE_TERMINATE:
          await this.instanceManager.terminate(params['instanceId'] as string);
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.INSTANCE_INTERRUPT:
          await this.instanceManager.interrupt(params['instanceId'] as string);
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.INSTANCE_HIBERNATE:
          await this.instanceManager.hibernate(params['instanceId'] as string);
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.INSTANCE_WAKE:
          await this.instanceManager.wake(params['instanceId'] as string);
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.NODE_PING:
          result = { pong: Date.now() };
          break;
        case COORDINATOR_TO_NODE.FS_READ_DIRECTORY:
          result = await this.fsHandler!.readDirectory(
            params as unknown as FsReadDirectoryParams
          );
          break;
        case COORDINATOR_TO_NODE.FS_STAT:
          result = await this.fsHandler!.stat(params as unknown as FsStatParams);
          break;
        case COORDINATOR_TO_NODE.FS_SEARCH:
          result = await this.fsHandler!.search(params as unknown as FsSearchParams);
          break;
        case COORDINATOR_TO_NODE.FS_WATCH:
          result = await this.fsHandler!.watch(params as unknown as FsWatchParams);
          break;
        case COORDINATOR_TO_NODE.FS_UNWATCH:
          await this.fsHandler!.unwatch(params as unknown as FsUnwatchParams);
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.FS_READ_FILE:
          result = await this.fsHandler!.readFile(
            params as unknown as FsReadFileParams
          );
          break;
        case COORDINATOR_TO_NODE.FS_WRITE_FILE:
          result = await this.fsHandler!.writeFile(
            params as unknown as FsWriteFileParams
          );
          break;
        case COORDINATOR_TO_NODE.SYNC_SCAN_DIRECTORY:
          result = await this.getSyncHandler().scanDirectory(
            params as unknown as SyncScanParams
          );
          break;
        case COORDINATOR_TO_NODE.SYNC_GET_BLOCK_SIGNATURES:
          result = await this.getSyncHandler().getBlockSignatures(
            params as unknown as SyncBlockSigParams
          );
          break;
        case COORDINATOR_TO_NODE.SYNC_COMPUTE_DELTA:
          result = await this.getSyncHandler().computeDelta(
            params as unknown as SyncComputeDeltaParams
          );
          break;
        case COORDINATOR_TO_NODE.SYNC_APPLY_DELTA:
          result = await this.getSyncHandler().applyDelta(
            params as unknown as SyncApplyDeltaParams
          );
          break;
        case COORDINATOR_TO_NODE.SYNC_DELETE_FILE:
          result = await this.getSyncHandler().deleteFile(
            params as unknown as SyncDeleteFileParams
          );
          break;
        default:
          this.sendError(
            msg.id!,
            RPC_ERROR_CODES.METHOD_NOT_FOUND,
            `Unknown method: ${msg.method}`
          );
          return;
      }
      this.sendResult(msg.id!, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(msg.id!, this.getRpcErrorCode(msg.method, err), message);
    }
  }

  private getSyncHandler(): SyncHandler {
    if (!this.syncHandler) {
      this.syncHandler = new SyncHandler(this.config.workingDirectories ?? []);
    }
    return this.syncHandler;
  }

  private getRpcErrorCode(method: string | undefined, err: unknown): number {
    if (err instanceof FsRpcError) {
      return RPC_ERROR_CODES.FILESYSTEM_ERROR;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Instance not found')) {
      return RPC_ERROR_CODES.INSTANCE_NOT_FOUND;
    }
    if (method === COORDINATOR_TO_NODE.INSTANCE_SPAWN) {
      return RPC_ERROR_CODES.SPAWN_FAILED;
    }
    return RPC_ERROR_CODES.INTERNAL_ERROR;
  }

  // -- Instance event forwarding ----------------------------------------------

  private wireInstanceEvents(): void {
    this.instanceManager.on(
      'instance:output',
      (instanceId: string, message: unknown) => {
        this.sendOutputNotification(instanceId, message);
      }
    );

    this.instanceManager.on(
      'instance:stateChange',
      (instanceId: string, state: unknown) => {
        this.sendCritical({
          jsonrpc: '2.0',
          id: `sc-${++this.criticalSeq}`,
          method: NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE,
          params: {
            instanceId,
            state,
            seq: this.criticalSeq,
            token: this.config.nodeToken ?? this.config.authToken
          }
        });
      }
    );

    this.instanceManager.on(
      'instance:exit',
      (instanceId: string, info: unknown) => {
        this.sendCritical({
          jsonrpc: '2.0',
          id: `exit-${++this.criticalSeq}`,
          method: NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE,
          params: {
            instanceId,
            state: 'exited',
            info,
            seq: this.criticalSeq,
            token: this.config.nodeToken ?? this.config.authToken
          }
        });
      }
    );

    this.instanceManager.on(
      'instance:permissionRequest',
      (instanceId: string, permission: unknown) => {
        this.sendCritical({
          jsonrpc: '2.0',
          id: `perm-${++this.criticalSeq}`,
          method: NODE_TO_COORDINATOR.INSTANCE_PERMISSION_REQUEST,
          params: {
            instanceId,
            permission,
            seq: this.criticalSeq,
            token: this.config.nodeToken ?? this.config.authToken
          }
        });
      }
    );

    this.instanceManager.on(
      'instance:context',
      (instanceId: string, usage: unknown) => {
        this.send({
          jsonrpc: '2.0',
          method: NODE_TO_COORDINATOR.INSTANCE_CONTEXT,
          params: {
            instanceId,
            usage,
            token: this.config.nodeToken ?? this.config.authToken
          }
        } as RpcMessage);
      }
    );
  }

  // -- Transport helpers ------------------------------------------------------

  private send(msg: RpcMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Flush any previously queued critical messages first (FIFO order)
      this.flushCriticalQueue();
      this.ws.send(JSON.stringify(msg), (err) => {
        if (err) console.error('Send error:', err.message);
      });
    } else {
      console.warn('[WorkerAgent] Message dropped — WebSocket not open', {
        method: msg.method,
        readyState: this.ws?.readyState
      });
    }
  }

  /**
   * Send a critical RPC message (state changes, exits, permission requests).
   * Unlike regular send(), these are queued when the WebSocket is unavailable
   * and flushed in order when the connection is restored.
   */
  private sendCritical(msg: RpcMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.flushCriticalQueue();
      this.ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          // Send failed mid-flight — queue it for retry
          console.warn(
            '[WorkerAgent] Critical send failed, queueing for retry',
            {
              method: msg.method,
              error: err.message
            }
          );
          this.enqueueCriticalMessage(msg);
        }
      });
    } else {
      this.enqueueCriticalMessage(msg);
    }
  }

  private enqueueCriticalMessage(msg: RpcMessage): void {
    // For state-change messages, supersede any older queued state change for the
    // same instance. This prevents the queue from wasting slots on outdated states
    // and ensures the most recent state is what gets delivered after reconnect.
    const msgParams = msg.params as Record<string, unknown> | undefined;
    const msgInstanceId = msgParams?.['instanceId'];
    if (
      msg.method === NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE &&
      msgInstanceId
    ) {
      const idx = this.criticalMessageQueue.findIndex((queued) => {
        if (queued.method !== NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE)
          return false;
        const qp = queued.params as Record<string, unknown> | undefined;
        return qp?.['instanceId'] === msgInstanceId;
      });
      if (idx !== -1) {
        const superseded = this.criticalMessageQueue[idx];
        this.criticalMessageQueue.splice(idx, 1);
        console.debug('[WorkerAgent] Superseded older state-change in queue', {
          instanceId: msgInstanceId,
          oldState: (superseded.params as Record<string, unknown>)?.['state'],
          newState: msgParams['state']
        });
      }
    }

    if (
      this.criticalMessageQueue.length >= WorkerAgent.CRITICAL_QUEUE_MAX_SIZE
    ) {
      // Drop oldest to prevent unbounded growth
      const dropped = this.criticalMessageQueue.shift();
      console.warn(
        '[WorkerAgent] Critical queue full, dropped oldest message',
        {
          method: dropped?.method
        }
      );
    }
    this.criticalMessageQueue.push(msg);
  }

  private flushCriticalQueue(): void {
    if (this.criticalMessageQueue.length === 0) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const queued = this.criticalMessageQueue;
    this.criticalMessageQueue = [];
    for (const msg of queued) {
      this.ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          // Re-queue failed messages so they aren't silently lost
          console.warn(
            '[WorkerAgent] Failed to flush critical message, re-queuing',
            {
              method: msg.method,
              error: err.message
            }
          );
          this.enqueueCriticalMessage(msg);
        }
      });
    }
  }

  private sendResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result } as RpcMessage);
  }

  private sendError(id: string | number, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } } as RpcMessage);
  }

  private sendOutputNotification(instanceId: string, message: unknown): void {
    this.outputBuffer.push({ instanceId, message });

    // Flush immediately if buffer is full
    if (this.outputBuffer.length >= WorkerAgent.OUTPUT_BATCH_MAX_SIZE) {
      this.flushOutputBuffer();
      return;
    }

    // Start flush timer if not already running
    if (!this.outputFlushTimer) {
      this.outputFlushTimer = setTimeout(() => {
        this.flushOutputBuffer();
      }, WorkerAgent.OUTPUT_BATCH_INTERVAL_MS);
      if (this.outputFlushTimer.unref) {
        this.outputFlushTimer.unref();
      }
    }
  }

  private flushOutputBuffer(): void {
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
    }

    if (this.outputBuffer.length === 0) return;

    const items = this.outputBuffer;
    this.outputBuffer = [];
    const token = this.config.nodeToken ?? this.config.authToken;

    if (items.length === 1) {
      // Single message — send as regular notification (no batch overhead)
      this.send({
        jsonrpc: '2.0',
        method: NODE_TO_COORDINATOR.INSTANCE_OUTPUT,
        params: {
          instanceId: items[0].instanceId,
          message: items[0].message,
          token
        }
      } as RpcMessage);
    } else {
      // Multiple messages — send as batch notification
      this.send({
        jsonrpc: '2.0',
        method: NODE_TO_COORDINATOR.INSTANCE_OUTPUT_BATCH,
        params: { items, token }
      } as RpcMessage);
    }
  }
}
