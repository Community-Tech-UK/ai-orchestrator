import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import { reportCapabilities } from './capability-reporter';
import { DiscoveryClient } from './discovery-client';
import { LocalInstanceManager } from './local-instance-manager';
import { nextReconnectDelayMs, RECONNECT_CONFIG } from './reconnect-backoff';
import type { WorkerConfig } from './worker-config';
import { persistConfig } from './worker-config';
import type { WorkerNodeCapabilities } from '../shared/types/worker-node.types';
import { NODE_TO_COORDINATOR } from '../main/remote-node/worker-node-rpc';
import type { EnrollmentResult } from '../main/remote-node/worker-node-rpc';
import { NodeFilesystemHandler } from '../main/remote-node/node-filesystem-handler';
import { SyncHandler } from './sync-handler';
import { WorkerTerminalHandler } from './worker-terminal-handler';
import { WorkerInstanceNotifier } from './worker-instance-notifier';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import type { RpcMessage } from './worker-rpc-types';
import type { DiscoveredCoordinator } from './discovery-client';

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.orchestrator',
  'worker-node.json'
);

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
  private terminalHandler: WorkerTerminalHandler | null = null;
  private readonly notifier: WorkerInstanceNotifier;
  private readonly rpcDispatcher: WorkerRpcDispatcher;
  private activeCoordinatorUrl: string | null = null;

  constructor(private readonly config: WorkerConfig) {
    super();
    this.instanceManager = new LocalInstanceManager(
      config.workingDirectories,
      config.maxConcurrentInstances
    );
    this.notifier = new WorkerInstanceNotifier({
      getSocket: () => this.ws,
      getToken: () => this.config.nodeToken ?? this.config.authToken,
    });
    this.rpcDispatcher = new WorkerRpcDispatcher({
      config: this.config,
      instanceManager: this.instanceManager,
      getFilesystemHandler: () => this.fsHandler!,
      getSyncHandler: () => this.getSyncHandler(),
      getTerminalHandler: () => this.getTerminalHandler(),
      sendResult: (id, result) => this.notifier.sendResult(id, result),
      sendError: (id, code, message) => this.notifier.sendError(id, code, message),
    });
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
      this.startContinuousDiscovery();

      // Resolve coordinator URL — prefer explicit config, fall back to mDNS.
      let coordinatorUrl = this.activeCoordinatorUrl ?? this.config.coordinatorUrl;
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
        coordinatorUrl = this.buildDiscoveredCoordinatorUrl(found);
        this.activeCoordinatorUrl = coordinatorUrl;
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
          this.activeCoordinatorUrl = coordinatorUrl as string;
          console.log(`Connected to coordinator at ${coordinatorUrl}`);
          this.sendRegistration();
          this.notifier.flushCriticalQueue(); // Deliver any queued state changes from while disconnected
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
    this.notifier.flushOutputBuffer();
    await this.instanceManager.terminateAll();
    this.fsHandler?.cleanupAllWatchers();
    this.terminalHandler?.killAll();
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
    this.notifier.send(this.buildRegistrationMessage());
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      // Refresh capabilities (memory changes over time)
      this.capabilities = await reportCapabilities(
        this.config.workingDirectories,
        this.config.maxConcurrentInstances
      );
      this.notifier.send({
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
   * or IP changes. Reuses the existing DiscoveryClient if already running.
   */
  private startContinuousDiscovery(): void {
    if (this.discoveryClient) return; // already running

    this.discoveryClient = new DiscoveryClient();
    this.discoveryClient.startContinuous(
      this.config.namespace,
      (coordinator) => {
        const discoveredUrl = this.buildDiscoveredCoordinatorUrl(coordinator);
        const currentUrl = this.activeCoordinatorUrl ?? this.config.coordinatorUrl;
        if (discoveredUrl !== currentUrl) {
          this.activeCoordinatorUrl = discoveredUrl;
          console.log(
            `Coordinator discovered at ${discoveredUrl}; future reconnects will use it`
          );
        }

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

  private buildDiscoveredCoordinatorUrl(coordinator: DiscoveredCoordinator): string {
    const currentUrl = this.activeCoordinatorUrl ?? this.config.coordinatorUrl;
    const protocol = currentUrl?.startsWith('wss://') ? 'wss' : 'ws';
    return `${protocol}://${coordinator.host}:${coordinator.port}`;
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
      if (msg.id !== undefined && msg.id === this.pendingRegistrationId && msg.error) {
        this.handleRegistrationError(msg.error);
        return;
      }

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

  private handleRegistrationError(error: unknown): void {
    const message = error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : 'registration rejected';
    this.pendingRegistrationId = null;

    if (this.config.nodeToken && this.config.authToken) {
      console.warn(
        `Registration rejected (${message}); clearing persisted node token and retrying with pairing token`
      );
      this.config.nodeToken = undefined;
      persistConfig(DEFAULT_CONFIG_PATH, this.config);
      this.ws?.close(4001, 'Retry registration with pairing token');
      return;
    }

    console.warn(`Registration rejected (${message})`);
  }

  private async handleRpcRequest(msg: RpcMessage): Promise<void> {
    return this.rpcDispatcher.handleRpcRequest(msg);
  }

  private getSyncHandler(): SyncHandler {
    if (!this.syncHandler) {
      this.syncHandler = new SyncHandler(this.config.workingDirectories ?? []);
    }
    return this.syncHandler;
  }

  private getTerminalHandler(): WorkerTerminalHandler {
    if (!this.terminalHandler) {
      this.terminalHandler = new WorkerTerminalHandler(
        this.config.workingDirectories ?? [],
        {
          onOutput: (sessionId, data) => this.sendTerminalOutput(sessionId, data),
          onExit: (sessionId, exitCode, signal) =>
            this.sendTerminalExit(sessionId, exitCode, signal)
        }
      );
    }
    return this.terminalHandler;
  }

  private sendTerminalOutput(sessionId: string, data: string): void {
    this.notifier.send({
      jsonrpc: '2.0',
      method: NODE_TO_COORDINATOR.TERMINAL_OUTPUT,
      params: {
        sessionId,
        data,
        token: this.config.nodeToken ?? this.config.authToken
      }
    });
  }

  private sendTerminalExit(
    sessionId: string,
    exitCode: number | null,
    signal: string | null
  ): void {
    this.notifier.send({
      jsonrpc: '2.0',
      method: NODE_TO_COORDINATOR.TERMINAL_EXIT,
      params: {
        sessionId,
        exitCode,
        signal,
        token: this.config.nodeToken ?? this.config.authToken
      }
    });
  }

  // -- Instance event forwarding ----------------------------------------------

  private wireInstanceEvents(): void {
    this.instanceManager.on(
      'instance:output',
      (instanceId: string, message: unknown) => {
        this.notifier.sendOutputNotification(instanceId, message);
      }
    );

    this.instanceManager.on(
      'instance:heartbeat',
      (instanceId: string) => {
        this.notifier.sendHeartbeatNotification(instanceId);
      }
    );

    this.instanceManager.on(
      'instance:complete',
      (instanceId: string, response: unknown) => {
        this.notifier.sendCompleteNotification(instanceId, response);
      }
    );

    this.instanceManager.on(
      'instance:stateChange',
      (instanceId: string, state: unknown) => {
        this.notifier.sendStateChange(instanceId, state);
      }
    );

    this.instanceManager.on(
      'instance:exit',
      (instanceId: string, info: unknown) => {
        this.notifier.sendExit(instanceId, info);
      }
    );

    this.instanceManager.on(
      'instance:permissionRequest',
      (instanceId: string, permission: unknown) => {
        this.notifier.sendPermissionRequest(instanceId, permission);
      }
    );

    this.instanceManager.on(
      'instance:context',
      (instanceId: string, usage: unknown) => {
        this.notifier.sendContextNotification(instanceId, usage);
      }
    );
  }
}
