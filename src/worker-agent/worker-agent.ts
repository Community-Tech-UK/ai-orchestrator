import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import { reportCapabilities } from './capability-reporter';
import { DiscoveryClient } from './discovery-client';
import { LocalInstanceManager, type SpawnParams } from './local-instance-manager';
import { nextReconnectDelayMs, RECONNECT_CONFIG } from './reconnect-backoff';
import type { WorkerConfig } from './worker-config';
import { persistConfig } from './worker-config';
import type { WorkerNodeCapabilities } from '../shared/types/worker-node.types';
import { COORDINATOR_TO_NODE, NODE_TO_COORDINATOR, RPC_ERROR_CODES } from '../main/remote-node/worker-node-rpc';
import type { EnrollmentResult } from '../main/remote-node/worker-node-rpc';

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.orchestrator', 'worker-node.json');

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
  private reconnectAttempt = 0;
  private connectedAt = 0;
  private pendingRegistrationId: string | number | null = null;
  private discoveryClient: DiscoveryClient | null = null;

  constructor(private readonly config: WorkerConfig) {
    super();
    this.instanceManager = new LocalInstanceManager(
      config.workingDirectories,
      config.maxConcurrentInstances,
    );
    this.wireInstanceEvents();
  }

  async connect(): Promise<void> {
    this.isShuttingDown = false;
    this.capabilities = await reportCapabilities(
      this.config.workingDirectories,
      this.config.maxConcurrentInstances,
    );

    // Resolve coordinator URL — prefer explicit config, fall back to mDNS.
    let coordinatorUrl = this.config.coordinatorUrl;
    if (!coordinatorUrl) {
      const discovery = new DiscoveryClient();
      const found = await discovery.discover(this.config.namespace, 10_000);
      if (!found) {
        throw new Error(`mDNS discovery found no coordinator for namespace "${this.config.namespace}"`);
      }
      coordinatorUrl = `ws://${found.host}:${found.port}`;
    }

    const token = this.config.nodeToken ?? this.config.authToken;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(coordinatorUrl as string, {
        headers: { Authorization: `Bearer ${token}` },
      });

      ws.on('open', () => {
        this.ws = ws;
        this.sendRegistration();
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
          reject(err);
        } else {
          this.emit('error', err);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.stopHeartbeat();
    this.stopContinuousDiscovery();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.instanceManager.terminateAll();
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
        token: this.config.nodeToken ?? this.config.authToken,
      },
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
        this.config.maxConcurrentInstances,
      );
      this.send({
        jsonrpc: '2.0',
        method: NODE_TO_COORDINATOR.HEARTBEAT,
        params: {
          nodeId: this.config.nodeId,
          capabilities: this.capabilities,
          activeInstances: this.instanceManager.getInstanceCount(),
          token: this.config.nodeToken ?? this.config.authToken,
        },
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
    if (this.connectedAt > 0 && Date.now() - this.connectedAt > RECONNECT_CONFIG.stableConnectionResetMs) {
      this.reconnectAttempt = 0;
    }

    const delay = nextReconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt++;
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this.connectedAt = Date.now();
        this.reconnectAttempt = 0;
      } catch {
        // connect() failed — close handler schedules next retry
      }
    }, delay);
  }

  // -- Continuous discovery ----------------------------------------------------

  /**
   * Keep mDNS browser running so the worker detects coordinator restarts
   * or IP changes. Only used when coordinatorUrl is not explicitly set.
   */
  private startContinuousDiscovery(): void {
    if (this.config.coordinatorUrl) return; // explicit URL — skip mDNS
    this.stopContinuousDiscovery();

    this.discoveryClient = new DiscoveryClient();
    this.discoveryClient.startContinuous(
      this.config.namespace,
      (coordinator) => {
        // Coordinator re-appeared or changed IP — reconnect if we're disconnected
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          console.log(`Coordinator re-discovered at ${coordinator.host}:${coordinator.port}, reconnecting...`);
          this.scheduleReconnect();
        }
      },
      (name) => {
        console.warn(`Coordinator ${name} disappeared from mDNS`);
      },
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
      // Check if this is the enrollment response to our registration
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
        case COORDINATOR_TO_NODE.INSTANCE_SEND_INPUT:
          await this.instanceManager.sendInput(
            params['instanceId'] as string,
            params['message'] as string,
          );
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.INSTANCE_TERMINATE:
          await this.instanceManager.terminate(params['instanceId'] as string);
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.INSTANCE_INTERRUPT:
          await this.instanceManager.interrupt(params['instanceId'] as string);
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.NODE_PING:
          result = { pong: Date.now() };
          break;
        default:
          this.sendError(msg.id!, RPC_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${msg.method}`);
          return;
      }
      this.sendResult(msg.id!, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(msg.id!, this.getRpcErrorCode(msg.method, err), message);
    }
  }

  private getRpcErrorCode(method: string | undefined, err: unknown): number {
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
    this.instanceManager.on('instance:output', (instanceId: string, message: unknown) => {
      this.send({
        jsonrpc: '2.0',
        id: `out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        method: NODE_TO_COORDINATOR.INSTANCE_OUTPUT,
        params: { instanceId, message, token: this.config.nodeToken ?? this.config.authToken },
      });
    });

    this.instanceManager.on('instance:stateChange', (instanceId: string, state: unknown) => {
      this.send({
        jsonrpc: '2.0',
        id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        method: NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE,
        params: { instanceId, state, token: this.config.nodeToken ?? this.config.authToken },
      });
    });

    this.instanceManager.on('instance:exit', (instanceId: string, info: unknown) => {
      this.send({
        jsonrpc: '2.0',
        id: `exit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        method: NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE,
        params: { instanceId, state: 'exited', info, token: this.config.nodeToken ?? this.config.authToken },
      });
    });

    this.instanceManager.on('instance:permissionRequest', (instanceId: string, permission: unknown) => {
      this.send({
        jsonrpc: '2.0',
        id: `perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        method: NODE_TO_COORDINATOR.INSTANCE_PERMISSION_REQUEST,
        params: { instanceId, permission, token: this.config.nodeToken ?? this.config.authToken },
      });
    });
  }

  // -- Transport helpers ------------------------------------------------------

  private send(msg: RpcMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg), (err) => {
        if (err) console.error('Send error:', err.message);
      });
    }
  }

  private sendResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result } as RpcMessage);
  }

  private sendError(id: string | number, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } } as RpcMessage);
  }
}
