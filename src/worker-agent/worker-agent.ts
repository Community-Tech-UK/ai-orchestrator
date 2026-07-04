import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import { reportCapabilities } from './capability-reporter';
import { DiscoveryClient } from './discovery-client';
import { LocalInstanceManager } from './local-instance-manager';
import { nextReconnectDelayMs, shouldResetReconnectAttempt } from './reconnect-backoff';
import type {
  WorkerAndroidAutomationConfig,
  WorkerBrowserAutomationConfig,
  WorkerConfig,
  WorkerExtensionRelayConfig,
} from './worker-config';
import {
  defaultExtensionRelaySocketPath,
  ensureExtensionRelayDefaults,
  persistConfig,
} from './worker-config';
import type {
  WorkerNodeBrowserAutomationSummary,
  WorkerNodeAndroidAutomationSummary,
  WorkerNodeCapabilities,
  WorkerNodeExtensionRelaySummary,
} from '../shared/types/worker-node.types';
import { NODE_TO_COORDINATOR } from '../main/remote-node/worker-node-rpc';
import type { EnrollmentResult } from '../main/remote-node/worker-node-rpc';
import {
  WORKER_NODE_WS_BACKPRESSURE_BYTES,
  WORKER_NODE_WS_MAX_PAYLOAD_BYTES,
} from '../main/remote-node/rpc-schemas';
import { NodeFilesystemHandler } from '../main/remote-node/node-filesystem-handler';
import { SyncHandler } from './sync-handler';
import { WorkerTerminalHandler } from './worker-terminal-handler';
import { WorkerInstanceNotifier } from './worker-instance-notifier';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import { WorkerBrowserManager } from './worker-browser-manager';
import { WorkerCdpTunnel } from './worker-cdp-tunnel';
import { WorkerAndroidManager } from './android/worker-android-manager';
import { WorkerExtensionRelay } from './worker-extension-relay';
import {
  ExtensionRelayNativeRegistration,
  prepareLegacyExtensionRelayNativeHostRuntime,
} from './extension-relay-native-registration';
import type { RpcMessage } from './worker-rpc-types';
import type { DiscoveredCoordinator } from './discovery-client';

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.orchestrator', 'worker-node.json');

const CONNECT_TIMEOUT_MS = 8_000;
const REDISCOVERY_TIMEOUT_MS = 4_000;
const EXTENSION_RELAY_REGISTRATION_CHECK_INTERVAL_MS = 60_000;

type PendingCoordinatorRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout>; method: string };

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
  private registrationAccepted = false;
  private requestCounter = 0;
  private readonly pendingRequests = new Map<string | number, PendingCoordinatorRequest>();
  private discoveryClient: DiscoveryClient | null = null;
  private fsHandler: NodeFilesystemHandler | null = null;
  private syncHandler: SyncHandler | null = null;
  private terminalHandler: WorkerTerminalHandler | null = null;
  private readonly notifier: WorkerInstanceNotifier;
  private readonly rpcDispatcher: WorkerRpcDispatcher;
  private readonly browserManager: WorkerBrowserManager;
  private readonly androidManager: WorkerAndroidManager;
  private readonly cdpTunnel: WorkerCdpTunnel;
  private readonly extensionRelay: WorkerExtensionRelay;
  private readonly extensionRelayRegistration: ExtensionRelayNativeRegistration;
  private lastExtensionRelayRegistrationCheckAt: number | null = null;
  private activeCoordinatorUrl: string | null = null;
  private retryRegistrationWithRecovery = false;

  constructor(
    private readonly config: WorkerConfig,
    private readonly configPath = DEFAULT_CONFIG_PATH,
  ) {
    super();
    // Always construct the manager (even when disabled) so browser automation
    // can be turned on at runtime via a coordinator `config.update` without
    // recreating the instance manager's reference.
    this.browserManager = new WorkerBrowserManager({
      config: config.browserAutomation ?? { enabled: false },
    });
    this.androidManager = new WorkerAndroidManager({
      config: config.androidAutomation ?? { enabled: false },
    });
    this.cdpTunnel = new WorkerCdpTunnel({ browserManager: this.browserManager });
    this.extensionRelay = new WorkerExtensionRelay({
      config: config.extensionRelay ?? { enabled: false },
      sendRequest: (method, params, timeoutMs) => this.sendRequest(method, params, timeoutMs),
    });
    this.extensionRelayRegistration = new ExtensionRelayNativeRegistration({
      userDataPath: path.dirname(this.configPath),
      hostCommand: this.currentWorkerNativeHostCommand(),
    });
    this.wireCdpTunnelEvents();
    this.instanceManager = new LocalInstanceManager(
      config.workingDirectories,
      config.maxConcurrentInstances,
      this.browserManager,
      this.androidManager
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
    // Safety net: WorkerAgent is an EventEmitter. A Node EventEmitter that emits
    // 'error' with no listener THROWS synchronously and crashes the process. This
    // no-op listener guarantees a stray 'error' emit (from anywhere) is never
    // fatal — the worker must survive its own bugs and reconnect, not exit.
    this.on('error', (err) => {
      console.warn(
        '[WorkerAgent] Non-fatal internal error event',
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  async connect(): Promise<void> {
    if (this.connecting) return; // Prevent concurrent connect() calls
    this.connecting = true;
    this.isShuttingDown = false;

    try {
      await this.runExtensionRelayStep('startup', () => this.extensionRelay.start());
      this.checkExtensionRelayRegistration({ force: true });
      this.capabilities = await reportCapabilities(
        this.config.workingDirectories,
        this.config.maxConcurrentInstances,
        this.browserManager.getSummary(),
        await this.androidManager.getSummary(),
        this.extensionRelay.getSummary(),
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
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        maxPayload: WORKER_NODE_WS_MAX_PAYLOAD_BYTES,
      });

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
        this.registrationAccepted = false;
        this.activeCoordinatorUrl = url;
        console.log(`Connected to coordinator at ${url}`);
        this.sendRegistration();
        this.startContinuousDiscovery();
        resolve(true);
      });

      ws.on('message', (data: Buffer | string) => {
        this.handleMessage(data.toString());
      });

      ws.on('close', (code?: number, reason?: Buffer) => {
        if (!opened) {
          clearTimeout(timer);
          resolve(false);
          return;
        }
        console.warn('[WorkerAgent] Coordinator socket closed', {
          url,
          code,
          reason: reason?.toString?.() || undefined,
        });
        this.stopHeartbeat();
        this.ws = null;
        this.registrationAccepted = false;
        this.rejectPendingRequests('coordinator_disconnected');
        this.cdpTunnel.closeAll();
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
        // Post-open socket error. Under network saturation this fires when the
        // link resets, and when the coordinator rejects an oversized frame with
        // WS 1009 it fires here too. Previously this re-emitted 'error' on the
        // WorkerAgent EventEmitter — with no 'error' listener that THREW and
        // crashed the whole worker with nothing to restart it (the root cause of
        // the 2026-07-03 "never re-registered" incident). Log it and tear the
        // socket down; the paired 'close' event re-enters the reconnect loop.
        console.warn(
          `[WorkerAgent] Coordinator socket error after connect: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.forceCloseSocket(ws);
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
    this.rejectPendingRequests('worker_shutting_down');
    await this.instanceManager.terminateAll();
    this.fsHandler?.cleanupAllWatchers();
    this.terminalHandler?.killAll();
    this.cdpTunnel.closeAll();
    await this.extensionRelay.stop();
    await this.browserManager.shutdown();
    await this.androidManager.shutdown();
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

  sendRequest<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    if (!this.registrationAccepted) {
      return Promise.reject(new Error('worker_not_registered'));
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('coordinator_not_connected'));
    }

    const id = `worker-${++this.requestCounter}`;
    const token = this.config.nodeToken ?? this.config.authToken;
    const request: RpcMessage = {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        ...(token ? { token } : {}),
      },
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`worker_request_timeout:${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        method,
      });
      ws.send(JSON.stringify(request), (err) => {
        if (!err) {
          return;
        }
        const pending = this.pendingRequests.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        reject(err);
      });
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      // The heartbeat refreshes capabilities (memory/browser probes) which can
      // reject. An unhandled rejection here would surface as a process-level
      // `unhandledRejection` — fatal for a worker with no supervision. Swallow
      // and log: a missed heartbeat is recoverable, a dead process is not.
      this.sendHeartbeat().catch((err) => {
        console.warn(
          '[WorkerAgent] Heartbeat failed (non-fatal)',
          err instanceof Error ? err.message : String(err),
        );
      });
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Terminate a coordinator socket without letting a throw escape. Used by the
   * post-open error handler and by the process-level fatal-error handler. The
   * socket's own 'close' event re-enters the reconnect loop.
   */
  private forceCloseSocket(ws: WebSocket | null): void {
    if (!ws) return;
    const closable = ws as unknown as { terminate?: () => void; close?: (code?: number, reason?: string) => void };
    try {
      if (typeof closable.terminate === 'function') {
        closable.terminate();
      } else if (typeof closable.close === 'function') {
        closable.close();
      }
    } catch {
      /* already closing */
    }
  }

  /**
   * Recover from a process-level `uncaughtException` / `unhandledRejection`
   * instead of exiting. Tears down the current socket (its 'close' schedules a
   * reconnect) and, if no socket is live, schedules a reconnect directly. The
   * worker survives its own bugs; only unrecoverable config errors should exit.
   */
  handleFatalProcessError(): void {
    if (this.isShuttingDown) return;
    const ws = this.ws;
    if (ws) {
      this.forceCloseSocket(ws);
    } else {
      this.scheduleReconnect();
    }
  }

  /** Refresh capabilities (memory/browser config change over time) and send. */
  private async sendHeartbeat(): Promise<void> {
    this.checkExtensionRelayRegistration();
    this.capabilities = await reportCapabilities(
      this.config.workingDirectories,
      this.config.maxConcurrentInstances,
      this.browserManager.getSummary(),
      await this.androidManager.getSummary(),
      this.extensionRelay.getSummary(),
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
    androidAutomation?: WorkerAndroidAutomationConfig;
    extensionRelay?: WorkerExtensionRelayConfig;
  }): Promise<{
    browserAutomation?: WorkerNodeBrowserAutomationSummary;
    androidAutomation?: WorkerNodeAndroidAutomationSummary;
    extensionRelay?: WorkerNodeExtensionRelaySummary;
  }> {
    if (update.browserAutomation) {
      // Merge onto the existing block so a partial update (e.g. just toggling
      // headless) doesn't wipe profileDir/chromePath. `enabled` is always present
      // in the incoming payload, so the merged result is well-formed.
      const merged: WorkerBrowserAutomationConfig = {
        ...this.config.browserAutomation,
        ...update.browserAutomation,
      };
      this.config.browserAutomation = merged;
      persistConfig(this.configPath, this.config);
      await this.browserManager.reconfigure(merged);
    }
    if (update.androidAutomation) {
      const merged: WorkerAndroidAutomationConfig = {
        ...this.config.androidAutomation,
        ...update.androidAutomation,
      };
      this.config.androidAutomation = merged;
      persistConfig(this.configPath, this.config);
      await this.androidManager.reconfigure(merged);
    }
    if (update.extensionRelay) {
      const merged = ensureExtensionRelayDefaults(
        {
          ...this.config.extensionRelay,
          ...update.extensionRelay,
        },
        defaultExtensionRelaySocketPath,
      ) ?? { enabled: false };
      this.config.extensionRelay = merged;
      persistConfig(this.configPath, this.config);
      await this.runExtensionRelayStep('reconfigure', () => this.extensionRelay.reconfigure(merged));
      this.checkExtensionRelayRegistration({ force: true });
    }
    // Only push a heartbeat when connected; otherwise the next reconnect reports
    // the updated capabilities.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      await this.sendHeartbeat();
    }
    return {
      browserAutomation: this.browserManager.getSummary(),
      androidAutomation: await this.androidManager.getSummary(),
      extensionRelay: this.extensionRelay.getSummary(),
    };
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

    if (shouldResetReconnectAttempt(this.connectedAt, Date.now())) {
      this.reconnectAttempt = 0;
    }
    this.connectedAt = 0;

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
          persistConfig(this.configPath, this.config);
        }
        this.retryRegistrationWithRecovery = false;
        this.pendingRegistrationId = null;
        this.registrationAccepted = true;
        // Record when this connection became stable. Do NOT reset
        // `reconnectAttempt` here: that would defeat the stable-connection gate
        // in scheduleReconnect() and let a flapping link (drops seconds after
        // registering) hammer the coordinator instead of backing off. The
        // counter is reset in exactly one place — scheduleReconnect(), and only
        // after ≥stableConnectionResetMs of continuous uptime.
        this.connectedAt = Date.now();
        console.log('[WorkerAgent] Registration accepted', {
          nodeId: this.config.nodeId,
          coordinator: this.activeCoordinatorUrl ?? this.config.coordinatorUrl,
          enrolled: changed,
        });
        this.notifier.flushCriticalQueue(); // Deliver queued state changes only after registration is accepted.
        this.startHeartbeat();
      }
      if (msg.id !== undefined && this.resolvePendingRequest(msg)) {
        return;
      }
      return;
    }

    // RPC request from coordinator
    if (msg.method && msg.id !== undefined) {
      this.handleRpcRequest(msg);
      return;
    }

    // RPC notification from coordinator
    if (msg.method) {
      this.handleRpcNotification(msg);
    }
  }

  private handleRegistrationError(error: unknown): void {
    const message = error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : 'registration rejected';
    this.pendingRegistrationId = null;
    this.registrationAccepted = false;
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
        `Registration rejected (${message}); clearing persisted node credentials and retrying with pairing token`
      );
      delete this.config.nodeToken;
      delete this.config.recoveryToken;
      persistConfig(this.configPath, this.config);
      this.ws?.close(4001, 'Retry registration with pairing token');
      return;
    }

    console.warn(`Registration rejected (${message})`);
  }

  private async handleRpcRequest(msg: RpcMessage): Promise<void> {
    return this.rpcDispatcher.handleRpcRequest(msg);
  }

  private resolvePendingRequest(msg: RpcMessage): boolean {
    if (msg.id === undefined) {
      return false;
    }
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
      return true;
    }
    pending.resolve(msg.result);
    return true;
  }

  private rejectPendingRequests(reason: string): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      pending.reject(new Error(`${reason}:${pending.method}`));
    }
  }

  private handleRpcNotification(msg: RpcMessage): void {
    this.rpcDispatcher.handleRpcNotification(msg);
  }

  private async runExtensionRelayStep(label: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      console.warn(`[WorkerAgent] Browser extension relay ${label} failed`, error instanceof Error ? error.message : String(error));
    }
  }

  private checkExtensionRelayRegistration(options: { force?: boolean } = {}): void {
    if (!this.config.extensionRelay?.enabled) {
      this.lastExtensionRelayRegistrationCheckAt = null;
      this.extensionRelay.setRegistrationSummary(undefined);
      return;
    }
    const now = Date.now();
    if (
      options.force !== true
      && this.lastExtensionRelayRegistrationCheckAt !== null
      && now - this.lastExtensionRelayRegistrationCheckAt < EXTENSION_RELAY_REGISTRATION_CHECK_INTERVAL_MS
    ) {
      return;
    }
    this.lastExtensionRelayRegistrationCheckAt = now;
    const summary = this.extensionRelayRegistration.checkAndRepair(this.config.extensionRelay);
    this.extensionRelay.setRegistrationSummary(summary);
    this.prepareLegacyExtensionNativeHostRuntime();
  }

  private prepareLegacyExtensionNativeHostRuntime(): void {
    const token = this.extensionRelay.getExtensionToken();
    if (
      !this.extensionRelay.isEnabled()
      || !token
      || this.config.extensionRelay?.legacyNameRegistration === false
    ) {
      return;
    }
    prepareLegacyExtensionRelayNativeHostRuntime({
      userDataPath: path.dirname(this.configPath),
      socketPath: this.extensionRelay.getSocketPath(),
      extensionToken: token,
      hostCommand: this.currentWorkerNativeHostCommand(),
    });
  }

  private currentWorkerNativeHostCommand(): { exe: string; args: string[] } {
    const entrypoint = process.argv[1];
    if (entrypoint && path.resolve(entrypoint) !== path.resolve(process.execPath)) {
      return {
        exe: process.execPath,
        args: [entrypoint, 'native-host'],
      };
    }
    return {
      exe: process.execPath,
      args: ['native-host'],
    };
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
      const sent = this.notifier.send({
        jsonrpc: '2.0',
        method: NODE_TO_COORDINATOR.BROWSER_CDP_MESSAGE,
        params: {
          sessionId,
          frame,
          token: this.config.nodeToken ?? this.config.authToken,
        },
      }, {
        highWatermarkBytes: WORKER_NODE_WS_BACKPRESSURE_BYTES,
      });
      if (!sent) {
        this.cdpTunnel.close(sessionId);
      }
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
      (instanceId: string, state: unknown, info?: unknown) => {
        this.notifier.sendStateChange(instanceId, state, info);
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
