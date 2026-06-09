import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import { reportCapabilities } from './capability-reporter';
import { DiscoveryClient } from './discovery-client';
import { LocalInstanceManager } from './local-instance-manager';
import { nextReconnectDelayMs, RECONNECT_CONFIG } from './reconnect-backoff';
import type { WorkerBrowserAutomationConfig, WorkerConfig } from './worker-config';
import { persistConfig } from './worker-config';
import type {
  WorkerNodeBrowserAutomationSummary,
  WorkerNodeCapabilities,
} from '../shared/types/worker-node.types';
import { NODE_TO_COORDINATOR } from '../main/remote-node/worker-node-rpc';
import type { EnrollmentResult } from '../main/remote-node/worker-node-rpc';
import { NodeFilesystemHandler } from '../main/remote-node/node-filesystem-handler';
import { SyncHandler } from './sync-handler';
import { WorkerTerminalHandler } from './worker-terminal-handler';
import { WorkerInstanceNotifier } from './worker-instance-notifier';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import { WorkerBrowserManager } from './worker-browser-manager';
import { WorkerCdpTunnel } from './worker-cdp-tunnel';
import type { RpcMessage } from './worker-rpc-types';
import type { DiscoveredCoordinator } from './discovery-client';

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.orchestrator',
  'worker-node.json'
);

/** Per-candidate connection timeout so a dead address fails over quickly. */
const CONNECT_TIMEOUT_MS = 8_000;

/** Bounded mDNS re-probe after every known address fails. */
const REDISCOVERY_TIMEOUT_MS = 4_000;

/**
 * Ordered, de-duplicated list of coordinator URLs to try: the most recently
 * discovered address first, then the paired primary, then static fallbacks.
 * Empty strings/nullish entries are dropped.
 */
export function buildCoordinatorCandidates(
  active: string | null | undefined,
  primary: string | undefined,
  fallbacks: string[] | undefined,
): string[] {
  const ordered = [active, primary, ...(fallbacks ?? [])];
  return [...new Set(ordered.filter((url): url is string => typeof url === 'string' && url.length > 0))];
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
  private terminalHandler: WorkerTerminalHandler | null = null;
  private readonly notifier: WorkerInstanceNotifier;
  private readonly rpcDispatcher: WorkerRpcDispatcher;
  private readonly browserManager: WorkerBrowserManager;
  private readonly cdpTunnel: WorkerCdpTunnel;
  private activeCoordinatorUrl: string | null = null;
  private retryRegistrationWithRecovery = false;

  constructor(private readonly config: WorkerConfig) {
    super();
    // Always construct the manager (even when disabled) so browser automation
    // can be turned on at runtime via a coordinator `config.update` without
    // recreating the instance manager's reference.
    this.browserManager = new WorkerBrowserManager({
      config: config.browserAutomation ?? { enabled: false },
    });
    this.cdpTunnel = new WorkerCdpTunnel({ browserManager: this.browserManager });
    this.wireCdpTunnelEvents();
    this.instanceManager = new LocalInstanceManager(
      config.workingDirectories,
      config.maxConcurrentInstances,
      this.browserManager
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
      applyConfigUpdate: (update) => this.applyConfigUpdate(update),
      getCdpTunnel: () => this.cdpTunnel,
      stopManagedBrowser: () => this.browserManager.shutdown(),
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
        this.config.maxConcurrentInstances,
        this.browserManager.getSummary()
      );
      this.fsHandler = new NodeFilesystemHandler(
        this.config.workingDirectories
      );
      this.startContinuousDiscovery();

      // Resolve the addresses to try. Prefer the configured/discovered
      // candidates; only fall back to a blocking mDNS lookup when nothing is
      // configured at all (first run before pairing has persisted a URL).
      let candidates = this.getCandidateUrls();
      if (candidates.length === 0) {
        const found = await new DiscoveryClient().discover(this.config.namespace, 10_000);
        if (!found) {
          console.warn(
            `mDNS discovery found no coordinator for namespace "${this.config.namespace}" — will retry`
          );
          this.scheduleReconnect();
          return;
        }
        candidates = [this.buildDiscoveredCoordinatorUrl(found)];
      }

      const token = this.config.nodeToken ?? this.config.authToken;

      // Try each known address in order, failing over on timeout/refusal. This
      // is what lets the worker recover when the host's LAN IP changes but a
      // stable fallback (e.g. a Tailscale name) is still reachable.
      for (const url of candidates) {
        if (await this.tryConnect(url, token)) {
          return;
        }
        console.warn(`Coordinator candidate unreachable: ${url}`);
      }

      // Every known address failed — re-probe mDNS in case the host moved and
      // is advertising a fresh address, then retry on the usual backoff.
      const rediscovered = await new DiscoveryClient().discover(
        this.config.namespace,
        REDISCOVERY_TIMEOUT_MS
      );
      if (rediscovered) {
        this.activeCoordinatorUrl = this.buildDiscoveredCoordinatorUrl(rediscovered);
      }
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private getCandidateUrls(): string[] {
    return buildCoordinatorCandidates(
      this.activeCoordinatorUrl,
      this.config.coordinatorUrl,
      this.config.coordinatorUrls
    );
  }

  /**
   * Attempt a single coordinator connection. Resolves `true` once the socket
   * opens (registration is sent synchronously on `open`), or `false` on
   * error/close/timeout so the caller can fail over to the next candidate.
   * Never rejects.
   */
  private tryConnect(url: string, token: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let opened = false;
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });

      const timer = setTimeout(() => {
        if (opened) return;
        console.warn(`Connection to ${url} timed out after ${CONNECT_TIMEOUT_MS}ms`);
        const closable = ws as unknown as { terminate?: () => void; close?: () => void };
        if (typeof closable.terminate === 'function') {
          closable.terminate();
        } else if (typeof closable.close === 'function') {
          closable.close();
        }
        resolve(false);
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        opened = true;
        clearTimeout(timer);
        this.ws = ws;
        this.connectedAt = Date.now();
        this.reconnectAttempt = 0;
        this.activeCoordinatorUrl = url;
        console.log(`Connected to coordinator at ${url}`);
        this.sendRegistration();
        this.notifier.flushCriticalQueue(); // Deliver any queued state changes from while disconnected
        this.startHeartbeat();
        this.startContinuousDiscovery();
        resolve(true);
      });

      ws.on('message', (data: Buffer | string) => {
        this.handleMessage(data.toString());
      });

      ws.on('close', () => {
        if (!opened) {
          clearTimeout(timer);
          resolve(false);
          return;
        }
        this.stopHeartbeat();
        this.ws = null;
        if (!this.isShuttingDown) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        if (!opened) {
          console.warn(
            `Connection to ${url} failed: ${err instanceof Error ? err.message : err}`
          );
          clearTimeout(timer);
          resolve(false);
          return;
        }
        this.emit('error', err);
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
    this.notifier.flushOutputBuffer();
    await this.instanceManager.terminateAll();
    this.fsHandler?.cleanupAllWatchers();
    this.terminalHandler?.killAll();
    this.cdpTunnel.closeAll();
    await this.browserManager.shutdown();
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
    const params: Record<string, unknown> = {
      nodeId: this.config.nodeId,
      name: this.config.name,
      capabilities: this.capabilities,
      token: this.config.nodeToken ?? this.config.authToken,
    };
    if (this.retryRegistrationWithRecovery && this.config.nodeToken && this.config.recoveryToken) {
      params['recoveryToken'] = this.config.recoveryToken;
    }
    return {
      jsonrpc: '2.0',
      id,
      method: NODE_TO_COORDINATOR.REGISTER,
      params,
    };
  }

  private sendRegistration(): void {
    this.notifier.send(this.buildRegistrationMessage());
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);
  }

  /** Refresh capabilities (memory/browser config change over time) and send. */
  private async sendHeartbeat(): Promise<void> {
    this.capabilities = await reportCapabilities(
      this.config.workingDirectories,
      this.config.maxConcurrentInstances,
      this.browserManager.getSummary()
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
  }

  /**
   * Apply a coordinator `config.update` at runtime. Merges the browser-automation
   * block into the persisted config, reconfigures the managed Chrome, and pushes
   * a fresh heartbeat so the coordinator reflects the new capabilities promptly.
   * Returns the resulting non-secret summary.
   */
  async applyConfigUpdate(update: {
    browserAutomation?: WorkerBrowserAutomationConfig;
  }): Promise<WorkerNodeBrowserAutomationSummary | undefined> {
    if (update.browserAutomation) {
      // Merge onto the existing block so a partial update (e.g. just toggling
      // headless) doesn't wipe profileDir/chromePath. `enabled` is always present
      // in the incoming payload, so the merged result is well-formed.
      const merged: WorkerBrowserAutomationConfig = {
        ...this.config.browserAutomation,
        ...update.browserAutomation,
      };
      this.config.browserAutomation = merged;
      persistConfig(DEFAULT_CONFIG_PATH, this.config);
      await this.browserManager.reconfigure(merged);
    }
    // Only push a heartbeat when connected; otherwise the next reconnect reports
    // the updated capabilities.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      await this.sendHeartbeat();
    }
    return this.browserManager.getSummary();
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
        let changed = false;
        if (enrollment.token) {
          this.config.nodeToken = enrollment.token;
          changed = true;
        }
        if (enrollment.recoveryToken) {
          this.config.recoveryToken = enrollment.recoveryToken;
          changed = true;
        }
        if (changed) {
          persistConfig(DEFAULT_CONFIG_PATH, this.config);
        }
        this.retryRegistrationWithRecovery = false;
        this.pendingRegistrationId = null;
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
    const justTriedRecovery = this.retryRegistrationWithRecovery;
    if (justTriedRecovery) {
      this.retryRegistrationWithRecovery = false;
      console.warn(
        `Registration recovery rejected (${message}); falling back to pairing token if available`
      );
    }

    if (!justTriedRecovery && this.config.nodeToken && this.config.recoveryToken) {
      console.warn(
        `Registration rejected (${message}); retrying with same-node recovery token`
      );
      this.retryRegistrationWithRecovery = true;
      this.ws?.close(4001, 'Retry registration with recovery token');
      return;
    }

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

  /**
   * Forward Chrome CDP frames (and socket close) from the tunnel up to the
   * coordinator as notifications. These ride the already-authenticated WS, so
   * the coordinator treats them as trusted high-frequency stream frames.
   */
  private wireCdpTunnelEvents(): void {
    this.cdpTunnel.on('message', ({ sessionId, frame }) => {
      this.notifier.send({
        jsonrpc: '2.0',
        method: NODE_TO_COORDINATOR.BROWSER_CDP_MESSAGE,
        params: {
          sessionId,
          frame,
          token: this.config.nodeToken ?? this.config.authToken,
        },
      });
    });
    this.cdpTunnel.on('closed', ({ sessionId }) => {
      this.notifier.send({
        jsonrpc: '2.0',
        method: NODE_TO_COORDINATOR.BROWSER_CDP_CLOSED,
        params: {
          sessionId,
          token: this.config.nodeToken ?? this.config.authToken,
        },
      });
    });
  }

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
