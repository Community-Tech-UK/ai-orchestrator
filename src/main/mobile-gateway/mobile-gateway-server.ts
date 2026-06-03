import * as os from 'os';
import { readFileSync } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createServer as createHttpsServer } from 'https';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';
import { URL } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { crossPlatformBasename } from '../../shared/utils/cross-platform-path';
import { getLogger } from '../logging/logger';
import { getIdempotencyStore, IdempotencyStore } from '../transport/idempotency-store';
import { resolveBindHost } from './tailscale-interface';
import { getMobileDeviceRegistry, type MobileDeviceRegistry } from './mobile-device-registry';
import { getMobileApnsSender, type MobileApnsSender } from './mobile-apns-sender';
import { getPauseCoordinator } from '../pause/pause-coordinator';
import { getRecentDirectoriesManager } from '../core/config/recent-directories-manager';
import { toOutputMessageFromProviderEnvelope } from '../providers/provider-output-event';
import type {
  Instance,
  FileAttachment,
  InstanceCreateConfig,
} from '../../shared/types/instance.types';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type {
  MobileGatewayStatus,
  MobileMessagesResumeDto,
  MobilePauseDto,
  MobilePromptDto,
  MobileServerEvent,
  MobileSnapshot,
  MobileHistorySessionDto,
} from '../../shared/types/mobile-gateway.types';
import {
  buildProjects,
  serializeHistoryMessage,
  serializeHistorySession,
  serializeInstance,
  serializeInstanceHistorySession,
  serializeMessage,
  WAITING_STATUSES,
  WORKING_STATUSES,
} from './mobile-gateway-serializers';
import type {
  GatewayChatHistorySource,
  GatewayInstanceHistorySource,
} from './mobile-gateway-serializers';
import {
  bearerFromHeader,
  corsHeaders,
  extractCertHostname,
  readJsonBody,
} from './mobile-gateway-http-utils';

export {
  buildProjects,
  serializeHistoryMessage,
  serializeHistorySession,
  serializeInstance,
  serializeInstanceHistorySession,
} from './mobile-gateway-serializers';
export { extractCertHostname } from './mobile-gateway-http-utils';
export type {
  GatewayChatHistorySource,
  GatewayHistoryChat,
  GatewayHistoryMessage,
  GatewayInstanceHistoryEntry,
  GatewayInstanceHistorySource,
} from './mobile-gateway-serializers';

const logger = getLogger('MobileGateway');

const SNAPSHOT_COALESCE_MS = 100;
const MESSAGE_REPLAY_LIMIT = 300;
/** Ping idle WS clients on this interval; reap any that miss a pong (dead cellular link). */
const WS_HEARTBEAT_MS = 30_000;

const VALID_PROVIDERS = new Set(['auto', 'claude', 'codex', 'gemini', 'copilot', 'cursor']);

/** Minimal EventEmitter surface the gateway subscribes to / detaches from. */
interface EmitterLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface GatewayOrchestrationSource extends EmitterLike {
  respondToUserAction(requestId: string, approved: boolean, selectedOption?: string): void;
}

/** Minimal pause-coordinator surface the gateway uses. */
export interface GatewayPauseSource extends EmitterLike {
  toPayload(): MobilePauseDto;
  addReason(reason: 'user', meta?: Record<string, unknown>): void;
  removeReason(reason: 'user'): void;
}

/** Minimal recent-directories surface the gateway uses. */
export interface GatewayRecentDirsSource {
  getDirectories(options?: { limit?: number }): Promise<
    { path: string; displayName: string; lastAccessed: number; isPinned: boolean }[]
  >;
}

/** id namespaces so /api/history/:id/messages can route to the right store. */
const HISTORY_CHAT_PREFIX = 'chat:';
const HISTORY_INSTANCE_PREFIX = 'inst:';

/**
 * Structural view of InstanceManager the gateway needs. The real InstanceManager
 * (an EventEmitter) satisfies this; tests pass a light double. Command methods
 * are called in-process — no IPC trust gate, no renderer refactor.
 */
export interface GatewayInstanceSource extends EmitterLike {
  getAllInstances(): Instance[];
  getInstance(id: string): Instance | undefined;
  sendInput(instanceId: string, message: string, attachments?: FileAttachment[]): Promise<void>;
  interruptInstance(instanceId: string): boolean;
  terminateInstance(instanceId: string, graceful?: boolean): Promise<void>;
  resumeAfterDeferredPermission(instanceId: string, approved: boolean, updatedInput?: Record<string, unknown>): Promise<void>;
  recordInputRequiredPermissionDecision(params: {
    instanceId: string;
    requestId: string;
    action: 'allow' | 'deny';
    scope: 'once' | 'session' | 'always';
  }): void;
  clearPendingInputRequiredPermission(instanceId: string, requestId: string): void;
  renameInstance(instanceId: string, displayName: string): void;
  createInstance(config: InstanceCreateConfig): Promise<Instance>;
  getOrchestrationHandler(): GatewayOrchestrationSource;
}

export interface MobileGatewayDeps {
  instanceManager: GatewayInstanceSource;
  /** Defaults to the settings-backed singletons; injectable for tests. */
  registry?: MobileDeviceRegistry;
  pauseCoordinator?: GatewayPauseSource;
  recentDirs?: GatewayRecentDirsSource;
  /** Persistent chat/session history. Defaults to the desktop ChatService. */
  chatHistory?: GatewayChatHistorySource;
  /** Persistent archive of closed instance sessions. Defaults to the HistoryManager. */
  instanceHistory?: GatewayInstanceHistorySource;
  apnsSender?: MobileApnsSender;
  /**
   * Resolves a worker-node name or id to a node id for remote-targeted
   * instance creation. Defaults to the worker-node registry; injectable so
   * tests don't depend on the remote-node singletons.
   */
  nodeResolver?: (nameOrId: string) => string | null;
}

export interface MobileGatewayStartOptions {
  port: number;
  bindInterface: 'tailscale' | 'all';
  /**
   * Optional TLS. When both paths are set and readable, the gateway serves
   * https/wss instead of http/ws. Tailscale already encrypts the link, so this
   * is extra hardening; point them at a `tailscale cert` key/cert pair.
   */
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

/** Resolved TLS material + the cert's primary DNS name, or null when not configured. */
interface ResolvedTls {
  cert: Buffer;
  key: Buffer;
  hostname: string | null;
}

export class MobileGatewayServer {
  private static instance: MobileGatewayServer | null = null;

  private deps: MobileGatewayDeps | null = null;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private boundHost = '';
  private boundPort = 0;
  private tailscaleIp: string | null = null;
  private secure = false;
  private tlsHostname: string | null = null;
  private startedAt = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Liveness flag per live WS client, driven by the ping/pong heartbeat reaper. */
  private readonly clientAlive = new WeakMap<WebSocket, boolean>();

  /** Pending "needs you" prompts keyed by requestId. */
  private readonly prompts = new Map<string, MobilePromptDto>();
  /**
   * Last observed status per instance, used to detect the working→idle
   * transition that fires a "agent finished" completion push. Pruned on removal.
   */
  private readonly lastStatusByInstance = new Map<string, string>();
  /** The orchestration handler we attached to, for clean detach on stop. */
  private orchestration: EmitterLike | null = null;
  private attachedPause: GatewayPauseSource | null = null;

  // Stable listener refs so we can detach exactly what we attached.
  private readonly onInstanceCreated = () => this.scheduleSnapshotBroadcast();
  private readonly onInstanceRemoved = (instanceId: unknown) =>
    this.handleInstanceRemoved(String(instanceId));
  private readonly onStateUpdate = (update: unknown) => this.handleStateUpdate(update);
  private readonly onBatchUpdate = (updates: unknown) => this.handleBatchUpdate(updates);
  private readonly onProviderEvent = (envelope: unknown) =>
    this.handleProviderEvent(envelope as ProviderRuntimeEventEnvelope);
  private readonly onInputRequired = (payload: unknown) => this.handleInputRequired(payload);
  private readonly onUserAction = (request: unknown) => this.handleUserAction(request);
  private readonly onPauseChange = () =>
    this.broadcast({ type: 'pause-state', data: this.pauseState() });

  static getInstance(): MobileGatewayServer {
    if (!this.instance) {
      this.instance = new MobileGatewayServer();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      void this.instance.stop();
    }
    this.instance = null;
  }

  initialize(deps: MobileGatewayDeps): void {
    this.deps = deps;
  }

  private get registry(): MobileDeviceRegistry {
    return this.deps?.registry ?? getMobileDeviceRegistry();
  }

  private get pause(): GatewayPauseSource {
    return this.deps?.pauseCoordinator ?? (getPauseCoordinator() as unknown as GatewayPauseSource);
  }

  private get recentDirs(): GatewayRecentDirsSource {
    return this.deps?.recentDirs ?? getRecentDirectoriesManager();
  }

  /**
   * Persistent chat/session history. Uses the injected source when present,
   * else lazily consults the desktop ChatService (guarded so a
   * missing/uninitialized service yields null rather than throwing).
   */
  private get chatHistory(): GatewayChatHistorySource | null {
    if (this.deps?.chatHistory) {
      return this.deps.chatHistory;
    }
    if (!this.deps?.instanceManager) {
      return null;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getChatService } = require('../chats') as typeof import('../chats');
      return getChatService({
        instanceManager: this.deps.instanceManager as unknown as Parameters<
          typeof getChatService
        >[0]['instanceManager'],
      }) as unknown as GatewayChatHistorySource;
    } catch {
      return null;
    }
  }

  /**
   * Persistent archive of closed instance sessions. Uses the injected source
   * when present, else lazily consults the HistoryManager (guarded so a
   * missing/uninitialized manager yields null rather than throwing).
   */
  private get instanceHistory(): GatewayInstanceHistorySource | null {
    if (this.deps?.instanceHistory) {
      return this.deps.instanceHistory;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getHistoryManager } = require('../history/history-manager') as typeof import('../history/history-manager');
      return getHistoryManager() as unknown as GatewayInstanceHistorySource;
    } catch {
      return null;
    }
  }

  private get apnsSender(): MobileApnsSender {
    return this.deps?.apnsSender ?? getMobileApnsSender();
  }

  /**
   * Resolve a worker-node name or id to a node id. Uses the injected resolver
   * when present; otherwise lazily consults the worker-node registry (guarded
   * so a missing/uninitialized registry just yields null rather than throwing).
   */
  private resolveNodeId(nameOrId: string): string | null {
    if (this.deps?.nodeResolver) {
      return this.deps.nodeResolver(nameOrId);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getWorkerNodeRegistry } = require('../remote-node');
      const registry = getWorkerNodeRegistry();
      const node = registry
        .getAllNodes()
        .find((n: { id: string; name: string }) => n.id === nameOrId || n.name === nameOrId);
      return node?.id ?? null;
    } catch {
      return null;
    }
  }

  async start(options: MobileGatewayStartOptions): Promise<MobileGatewayStatus> {
    if (this.httpServer) {
      return this.getStatus();
    }
    if (!this.deps) {
      throw new Error('Mobile gateway dependencies have not been initialized.');
    }

    const { host, tailscaleIp } = resolveBindHost(options.bindInterface);
    this.tailscaleIp = tailscaleIp;

    const tls = this.resolveTls(options.tlsCertPath, options.tlsKeyPath);
    this.secure = tls !== null;
    this.tlsHostname = tls?.hostname ?? null;

    const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
      void this.handleRequest(req, res);
    };
    const httpServer: Server = tls
      ? createHttpsServer({ cert: tls.cert, key: tls.key }, requestHandler)
      : createServer(requestHandler);
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.on('error', reject);
      httpServer.listen(options.port, host, () => {
        this.httpServer = httpServer;
        const address = httpServer.address() as AddressInfo | null;
        this.boundHost = host;
        this.boundPort = address?.port ?? options.port;
        this.startedAt = Date.now();
        resolve();
      });
    });

    this.attachListeners();
    this.startHeartbeat();

    logger.info('Mobile gateway started', {
      host: this.boundHost,
      port: this.boundPort,
      tailscaleIp: this.tailscaleIp,
      secure: this.secure,
      tlsHostname: this.tlsHostname,
      pushConfigured: this.safeIsPushConfigured(),
    });
    return this.getStatus();
  }

  async stop(): Promise<MobileGatewayStatus> {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.detachListeners();

    for (const client of this.clients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.prompts.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      logger.info('Mobile gateway stopped');
    }

    this.boundPort = 0;
    this.startedAt = 0;
    this.secure = false;
    this.tlsHostname = null;
    return this.getStatus();
  }

  isRunning(): boolean {
    return this.httpServer !== null;
  }

  getStatus(): MobileGatewayStatus {
    const running = this.isRunning();
    // When serving TLS the phone must connect by the cert's DNS name (an IP won't
    // match the cert), so advertise the cert hostname; fall back to the tailnet IP.
    const scheme = this.secure ? 'wss' : 'ws';
    const urlHost = this.secure ? this.tlsHostname ?? this.tailscaleIp : this.tailscaleIp;
    return {
      running,
      host: running ? this.boundHost : undefined,
      port: running ? this.boundPort : undefined,
      tailscaleIp: this.tailscaleIp,
      secure: this.secure,
      tlsHostname: this.tlsHostname,
      tailnetUrl:
        running && urlHost ? `${scheme}://${urlHost}:${this.boundPort}/ws` : undefined,
      startedAt: running ? this.startedAt : undefined,
      connectedClientCount: this.clients.size,
      pairedDeviceCount: this.registry.deviceCount(),
      pushConfigured: this.safeIsPushConfigured(),
    };
  }

  private safeIsPushConfigured(): boolean {
    try {
      return this.apnsSender.isConfigured();
    } catch {
      return false;
    }
  }

  /**
   * Read the configured TLS cert+key. Returns null (→ plain ws) when either path
   * is unset or unreadable — TLS is opt-in and must never block startup.
   */
  private resolveTls(certPath?: string, keyPath?: string): ResolvedTls | null {
    const certFile = certPath?.trim();
    const keyFile = keyPath?.trim();
    if (!certFile || !keyFile) {
      return null;
    }
    try {
      const cert = readFileSync(certFile);
      const key = readFileSync(keyFile);
      return { cert, key, hostname: extractCertHostname(cert.toString('utf-8')) };
    } catch (err) {
      logger.warn('Mobile gateway TLS configured but cert/key unreadable — falling back to ws://', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Ping idle WS clients and reap any that miss a pong. Without this a phone that
   * drops off cellular leaves a half-open socket in `clients` forever, and every
   * broadcast keeps buffering to it. Cleared on stop().
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (this.clientAlive.get(client) === false) {
          this.clients.delete(client);
          try {
            client.terminate();
          } catch {
            /* ignore */
          }
          continue;
        }
        this.clientAlive.set(client, false);
        try {
          client.ping();
        } catch {
          /* ignore */
        }
      }
    }, WS_HEARTBEAT_MS);
    // Don't keep the event loop alive solely for the heartbeat.
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  // ---------------------------------------------------------------------------
  // Event subscription
  // ---------------------------------------------------------------------------

  private attachListeners(): void {
    const { instanceManager } = this.deps!;
    instanceManager.on('instance:created', this.onInstanceCreated);
    instanceManager.on('instance:removed', this.onInstanceRemoved);
    instanceManager.on('instance:state-update', this.onStateUpdate);
    instanceManager.on('instance:batch-update', this.onBatchUpdate);
    instanceManager.on('provider:normalized-event', this.onProviderEvent);
    instanceManager.on('instance:input-required', this.onInputRequired);

    try {
      this.orchestration = instanceManager.getOrchestrationHandler();
      this.orchestration.on('user-action-request', this.onUserAction);
    } catch (err) {
      logger.warn('Could not attach orchestration listener', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      this.attachedPause = this.pause;
      this.attachedPause.on('change', this.onPauseChange);
    } catch (err) {
      logger.warn('Could not attach pause listener', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private detachListeners(): void {
    if (!this.deps) return;
    const { instanceManager } = this.deps;
    instanceManager.removeListener('instance:created', this.onInstanceCreated);
    instanceManager.removeListener('instance:removed', this.onInstanceRemoved);
    instanceManager.removeListener('instance:state-update', this.onStateUpdate);
    instanceManager.removeListener('instance:batch-update', this.onBatchUpdate);
    instanceManager.removeListener('provider:normalized-event', this.onProviderEvent);
    instanceManager.removeListener('instance:input-required', this.onInputRequired);
    this.orchestration?.removeListener('user-action-request', this.onUserAction);
    this.orchestration = null;
    this.attachedPause?.removeListener('change', this.onPauseChange);
    this.attachedPause = null;
  }

  private handleInstanceRemoved(instanceId: string): void {
    this.clearPromptsForInstance(instanceId);
    this.lastStatusByInstance.delete(instanceId);
    this.scheduleSnapshotBroadcast();
  }

  private handleStateUpdate(update: unknown): void {
    const u = update as { instanceId?: string; status?: string };
    if (u.instanceId && u.status) {
      if (!WAITING_STATUSES.has(u.status)) {
        this.clearPromptsForInstance(u.instanceId);
      }
      this.notifyCompletionOnIdle(u.instanceId, u.status);
    }
    this.scheduleSnapshotBroadcast();
  }

  private handleBatchUpdate(updates: unknown): void {
    const data = updates as { updates?: { instanceId?: string; status?: string }[] };
    if (data.updates) {
      for (const u of data.updates) {
        if (u.instanceId && u.status) {
          if (!WAITING_STATUSES.has(u.status)) {
            this.clearPromptsForInstance(u.instanceId);
          }
          this.notifyCompletionOnIdle(u.instanceId, u.status);
        }
      }
    }
    this.scheduleSnapshotBroadcast();
  }

  /**
   * Sends a non-approval "agent finished" push when an instance transitions out
   * of a working status into `idle` (a completed turn awaiting the user's next
   * message). Only the working→idle edge fires — repeated idle heartbeats and the
   * first-ever status for an instance are ignored — so the user is pinged once per
   * completed turn, not on every snapshot.
   */
  private notifyCompletionOnIdle(instanceId: string, status: string): void {
    const prev = this.lastStatusByInstance.get(instanceId);
    this.lastStatusByInstance.set(instanceId, status);
    if (prev && WORKING_STATUSES.has(prev) && status === 'idle') {
      this.sendCompletionPush(instanceId);
    }
  }

  private handleProviderEvent(envelope: ProviderRuntimeEventEnvelope): void {
    if (this.clients.size === 0) return;
    const message = toOutputMessageFromProviderEnvelope(envelope);
    if (!message) return;
    this.broadcast({
      type: 'instance-output',
      data: {
        instanceId: envelope.instanceId,
        seq: envelope.seq,
        message: serializeMessage(message),
      },
    });
  }

  private handleInputRequired(payload: unknown): void {
    const p = payload as {
      instanceId: string;
      requestId: string;
      prompt?: string;
      timestamp?: number;
      metadata?: Record<string, unknown>;
    };
    if (!p?.instanceId || !p?.requestId) return;
    const meta = p.metadata ?? {};
    const toolName =
      (typeof meta['tool_name'] === 'string' && meta['tool_name']) ||
      (typeof meta['toolName'] === 'string' && meta['toolName']) ||
      undefined;
    const toolInput =
      meta['tool_input'] && typeof meta['tool_input'] === 'object'
        ? (meta['tool_input'] as Record<string, unknown>)
        : undefined;
    this.addPrompt({
      id: p.requestId,
      instanceId: p.instanceId,
      requestId: p.requestId,
      kind: 'permission',
      toolName: toolName || undefined,
      toolInput,
      title: toolName ? `${toolName} needs approval` : 'Permission required',
      message: p.prompt || (toolName ? `Allow ${toolName}?` : 'An action needs your approval.'),
      createdAt: p.timestamp || Date.now(),
    });
  }

  private handleUserAction(request: unknown): void {
    const r = request as {
      id: string;
      instanceId: string;
      requestType?: unknown;
      title?: string;
      message?: string;
      options?: { id: string; label: string; description?: string }[];
      questions?: unknown;
      createdAt?: number;
    };
    if (!r?.id || !r?.instanceId) return;
    this.addPrompt({
      id: r.id,
      instanceId: r.instanceId,
      requestId: r.id,
      kind: 'user-action',
      requestType:
        r.requestType === 'switch_mode' ||
        r.requestType === 'approve_action' ||
        r.requestType === 'confirm' ||
        r.requestType === 'select_option' ||
        r.requestType === 'ask_questions'
          ? r.requestType
          : undefined,
      title: r.title || 'Input needed',
      message: r.message || 'An AI instance is waiting for your response.',
      options: Array.isArray(r.options)
        ? r.options
            .filter(
              (o): o is { id: string; label: string; description?: string } =>
                Boolean(o) && typeof o.id === 'string' && typeof o.label === 'string',
            )
            .map((o) => ({
              id: o.id,
              label: o.label,
              description: typeof o.description === 'string' ? o.description : undefined,
            }))
        : undefined,
      questions: Array.isArray(r.questions)
        ? r.questions.filter((q): q is string => typeof q === 'string')
        : undefined,
      createdAt: r.createdAt || Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // Prompt store
  // ---------------------------------------------------------------------------

  private addPrompt(prompt: MobilePromptDto): void {
    this.prompts.set(prompt.id, prompt);
    this.broadcast({ type: 'permission-prompt', data: prompt });
    this.sendPush(prompt);
    // The rollup counts changed; refresh the snapshot too.
    this.scheduleSnapshotBroadcast();
  }

  private clearPrompt(requestId: string): void {
    const prompt = this.prompts.get(requestId);
    if (!prompt) return;
    this.prompts.delete(requestId);
    this.broadcast({
      type: 'permission-cleared',
      data: { requestId, instanceId: prompt.instanceId },
    });
    this.scheduleSnapshotBroadcast();
  }

  private clearPromptsForInstance(instanceId: string): void {
    for (const [id, prompt] of this.prompts) {
      if (prompt.instanceId === instanceId) {
        this.prompts.delete(id);
        this.broadcast({ type: 'permission-cleared', data: { requestId: id, instanceId } });
      }
    }
  }

  private sendPush(prompt: MobilePromptDto): void {
    try {
      const sender = this.apnsSender;
      if (!sender.isConfigured()) return;
      const tokens = this.registry.apnsTokens();
      if (tokens.length === 0) return;
      const instance = this.deps?.instanceManager.getInstance(prompt.instanceId);
      const where = instance?.workingDirectory
        ? crossPlatformBasename(instance.workingDirectory)
        : '';
      const agent = instance?.displayName || 'Agent';
      const title =
        prompt.kind === 'permission'
          ? prompt.toolName
            ? `${prompt.toolName} needs approval`
            : 'Approval needed'
          : prompt.title;
      const body = where ? `${agent} · ${where}` : agent;
      void sender
        .send(tokens, {
          title,
          body,
          category: 'AIO_APPROVAL',
          threadId: prompt.instanceId,
          data: {
            instanceId: prompt.instanceId,
            requestId: prompt.requestId,
            kind: prompt.kind,
          },
        })
        .catch((err) =>
          logger.debug('APNs send failed', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    } catch (err) {
      logger.debug('sendPush threw', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private sendCompletionPush(instanceId: string): void {
    try {
      const sender = this.apnsSender;
      if (!sender.isConfigured()) return;
      const tokens = this.registry.apnsTokens();
      if (tokens.length === 0) return;
      const instance = this.deps?.instanceManager.getInstance(instanceId);
      const where = instance?.workingDirectory
        ? crossPlatformBasename(instance.workingDirectory)
        : '';
      const agent = instance?.displayName || 'Agent';
      void sender
        .send(tokens, {
          title: `${agent} finished`,
          body: where ? `Idle · ${where}` : 'Ready for your next message',
          category: 'AIO_COMPLETE',
          threadId: instanceId,
          data: {
            instanceId,
            kind: 'completion',
          },
        })
        .catch((err) =>
          logger.debug('APNs completion send failed', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    } catch (err) {
      logger.debug('sendCompletionPush threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private pauseState(): MobilePauseDto {
    try {
      return this.pause.toPayload();
    } catch {
      return { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 };
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot building
  // ---------------------------------------------------------------------------

  buildSnapshot(): MobileSnapshot {
    const promptCounts = new Map<string, number>();
    for (const prompt of this.prompts.values()) {
      promptCounts.set(prompt.instanceId, (promptCounts.get(prompt.instanceId) ?? 0) + 1);
    }
    const instances = (this.deps?.instanceManager.getAllInstances() ?? [])
      .filter((instance) => instance.status !== 'terminated')
      .map(serializeInstance)
      .map((dto) =>
        promptCounts.has(dto.id)
          ? { ...dto, pendingApprovalCount: promptCounts.get(dto.id)! }
          : dto,
      );
    return {
      hostName: os.hostname(),
      serverTime: Date.now(),
      instances,
      projects: buildProjects(instances),
      prompts: [...this.prompts.values()],
      pause: this.pauseState(),
    };
  }

  private scheduleSnapshotBroadcast(): void {
    if (this.snapshotTimer || !this.httpServer) {
      return;
    }
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.broadcast({ type: 'snapshot', data: this.buildSnapshot() });
    }, SNAPSHOT_COALESCE_MS);
  }

  private broadcast(event: MobileServerEvent): void {
    if (this.clients.size === 0) {
      return;
    }
    const raw = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get('token') || bearerFromHeader(req.headers['authorization']);
      if (!this.registry.validateToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const wss = this.wss;
      if (!wss) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleWsConnection(ws);
      });
    } catch (err) {
      logger.warn('WS upgrade failed', { error: err instanceof Error ? err.message : String(err) });
      socket.destroy();
    }
  }

  private handleWsConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.clientAlive.set(ws, true);
    ws.on('pong', () => this.clientAlive.set(ws, true));
    ws.on('close', () => {
      this.clients.delete(ws);
    });
    ws.on('error', () => {
      this.clients.delete(ws);
    });
    // Initial snapshot (includes pending prompts + pause state).
    ws.send(
      JSON.stringify({ type: 'snapshot', data: this.buildSnapshot() } satisfies MobileServerEvent),
    );
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${this.boundHost || 'localhost'}:${this.boundPort}`);
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      this.sendJson(res, 200, { ok: true, running: this.isRunning() });
      return;
    }

    if (url.pathname === '/pair' && method === 'POST') {
      await this.handlePair(req, res);
      return;
    }

    // Everything below requires a valid device token.
    const device = this.registry.validateToken(bearerFromHeader(req.headers['authorization']));
    if (!device) {
      this.sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const segments = url.pathname.split('/').filter(Boolean);

    try {
      // /api/...
      if (segments[0] === 'api') {
        // /api/instances ...
        if (segments[1] === 'instances') {
          if (segments.length === 2) {
            if (method === 'GET') return this.sendJson(res, 200, this.buildSnapshot().instances);
            if (method === 'POST') return await this.handleCreateInstance(req, res);
          }
          if (segments.length === 4) {
            const instanceId = decodeURIComponent(segments[2]);
            const action = segments[3];
            if (action === 'messages' && method === 'GET') {
              return this.handleMessages(res, instanceId, url);
            }
            if (action === 'input' && method === 'POST') {
              return await this.handleInput(req, res, instanceId);
            }
            if (action === 'respond' && method === 'POST') {
              return await this.handleRespond(req, res, instanceId);
            }
            if (action === 'interrupt' && method === 'POST') {
              return this.handleInterrupt(res, instanceId);
            }
            if (action === 'terminate' && method === 'POST') {
              return await this.handleTerminate(req, res, instanceId);
            }
            if (action === 'rename' && method === 'POST') {
              return await this.handleRename(req, res, instanceId);
            }
          }
        }

        if (segments[1] === 'projects' && segments.length === 2 && method === 'GET') {
          return this.sendJson(res, 200, this.buildSnapshot().projects);
        }
        if (segments[1] === 'snapshot' && segments.length === 2 && method === 'GET') {
          return this.sendJson(res, 200, this.buildSnapshot());
        }
        if (segments[1] === 'prompts' && segments.length === 2 && method === 'GET') {
          return this.sendJson(res, 200, [...this.prompts.values()]);
        }
        if (segments[1] === 'pause' && segments.length === 2) {
          if (method === 'GET') return this.sendJson(res, 200, this.pauseState());
          if (method === 'POST') return await this.handleSetPause(req, res);
        }
        if (segments[1] === 'recent-dirs' && segments.length === 2 && method === 'GET') {
          return await this.handleRecentDirs(res);
        }
        if (segments[1] === 'history' && method === 'GET') {
          if (segments.length === 2) {
            return this.handleHistory(res);
          }
          if (segments.length === 4 && segments[3] === 'messages') {
            return await this.handleHistoryMessages(res, decodeURIComponent(segments[2]));
          }
        }
        if (
          segments[1] === 'devices' &&
          segments.length === 4 &&
          segments[3] === 'apns-token' &&
          method === 'POST'
        ) {
          return await this.handleApnsToken(req, res, decodeURIComponent(segments[2]), device.deviceId);
        }
      }

      this.sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.warn('Request handler error', {
        path: url.pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      this.sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
    }
  }

  private source(): GatewayInstanceSource {
    if (!this.deps) throw new Error('Gateway not initialized');
    return this.deps.instanceManager;
  }

  private handleMessages(res: ServerResponse, instanceId: string, url: URL): void {
    const instance = this.source().getInstance(instanceId);
    if (!instance) {
      this.sendJson(res, 404, { error: 'Instance not found' });
      return;
    }

    const buffer = instance.outputBuffer ?? [];
    const rawFromSeq = url.searchParams.get('fromSeq');

    // Absent fromSeq: legacy path — last MESSAGE_REPLAY_LIMIT messages, byte-for-byte
    // equivalent to before except each DTO now carries its buffer index as `seq`.
    if (rawFromSeq === null) {
      const start = Math.max(0, buffer.length - MESSAGE_REPLAY_LIMIT);
      const messages = buffer
        .slice(start)
        .map((msg, sliceIdx) => serializeMessage(msg, start + sliceIdx));
      this.sendJson(res, 200, messages);
      return;
    }

    // fromSeq present: parse and validate.
    const parsed = Number(rawFromSeq);
    // Treat NaN, negative, or non-integer as "start from 0" (safe degradation —
    // the client sent garbage but we still serve something useful rather than 400).
    const fromSeq = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;

    // Messages with buffer index strictly greater than fromSeq.
    // "seq" of message at buffer[i] === i (0-based).
    // Slice from (fromSeq + 1) onward, then cap to MESSAGE_REPLAY_LIMIT.
    const firstIdx = fromSeq + 1;
    const available = Math.max(0, buffer.length - firstIdx);
    const hasMore = available > MESSAGE_REPLAY_LIMIT;
    // Take at most MESSAGE_REPLAY_LIMIT messages starting at firstIdx.
    const sliceEnd = firstIdx + MESSAGE_REPLAY_LIMIT;
    const sliced = buffer.slice(firstIdx, sliceEnd);
    const messages = sliced.map((msg, sliceIdx) => serializeMessage(msg, firstIdx + sliceIdx));

    const maxSeq = messages.length > 0 ? (firstIdx + messages.length - 1) : fromSeq;

    logger.info('Mobile: client attached from seq', {
      instanceId,
      fromSeq,
      returned: messages.length,
      hasMore,
      bufferLength: buffer.length,
    });

    const envelope: MobileMessagesResumeDto = {
      messages,
      meta: {
        fromSeq,
        returned: messages.length,
        hasMore,
        maxSeq,
      },
    };
    this.sendJson(res, 200, envelope);
  }

  private async handleInput(
    req: IncomingMessage,
    res: ServerResponse,
    instanceId: string,
  ): Promise<void> {
    const body = (await readJsonBody(req)) as {
      message?: unknown;
      attachments?: unknown;
    };
    const message = typeof body.message === 'string' ? body.message : '';
    const attachments = Array.isArray(body.attachments)
      ? (body.attachments as FileAttachment[])
      : undefined;
    if (!message && (!attachments || attachments.length === 0)) {
      this.sendJson(res, 400, { error: 'message or attachments required' });
      return;
    }
    if (!this.source().getInstance(instanceId)) {
      this.sendJson(res, 404, { error: 'Instance not found' });
      return;
    }
    await this.source().sendInput(instanceId, message, attachments);
    this.sendJson(res, 200, { ok: true });
  }

  private async handleRespond(
    req: IncomingMessage,
    res: ServerResponse,
    instanceId: string,
  ): Promise<void> {
    const body = (await readJsonBody(req)) as {
      requestId?: unknown;
      decisionAction?: unknown;
      decisionScope?: unknown;
      response?: unknown;
      updatedInput?: unknown;
      idempotencyKey?: unknown;
    };
    const requestId = typeof body.requestId === 'string' ? body.requestId : '';
    const decisionAction =
      body.decisionAction === 'allow' || body.decisionAction === 'deny' || body.decisionAction === 'modify'
        ? (body.decisionAction as 'allow' | 'deny' | 'modify')
        : null;
    const decisionScope =
      body.decisionScope === 'once' || body.decisionScope === 'session' || body.decisionScope === 'always'
        ? (body.decisionScope as 'once' | 'session' | 'always')
        : undefined;

    // Parse and validate updatedInput: must be a plain non-empty object when present.
    let updatedInput: Record<string, unknown> | undefined;
    if (body.updatedInput !== undefined) {
      if (
        typeof body.updatedInput !== 'object' ||
        body.updatedInput === null ||
        Array.isArray(body.updatedInput) ||
        Object.keys(body.updatedInput as object).length === 0
      ) {
        this.sendJson(res, 400, { error: 'updatedInput must be a non-empty plain object' });
        return;
      }
      updatedInput = body.updatedInput as Record<string, unknown>;
    }

    if (!requestId || !decisionAction) {
      this.sendJson(res, 400, { error: 'requestId and decisionAction (allow|deny|modify) required' });
      return;
    }

    // Fail-safe: 'modify' without updatedInput must never silently degrade to a
    // plain allow of the original input.
    if (decisionAction === 'modify' && !updatedInput) {
      this.sendJson(res, 400, {
        error: "decisionAction 'modify' requires a non-empty updatedInput object",
      });
      return;
    }

    // B2: at-most-once — a permission request is answered once. A retried respond
    // (same requestId, or an explicit idempotencyKey) must not resume twice.
    const respondKey =
      typeof body.idempotencyKey === 'string' && body.idempotencyKey.length > 0
        ? body.idempotencyKey
        : requestId;
    if (getIdempotencyStore().isDuplicate(
      IdempotencyStore.compose('respond', instanceId, respondKey),
    )) {
      this.sendJson(res, 200, { ok: true, duplicate: true });
      return;
    }

    // WARN: 'modify' depends on the installed Claude CLI honouring updatedInput in
    // its PreToolUse hook reply.  If the CLI version does not support it, the tool
    // will run with the ORIGINAL (unmodified) input.
    if (decisionAction === 'modify') {
      logger.warn('Mobile: deferred permission modify decision — CLI support unverified', {
        instanceId,
        requestId,
        updatedInputKeys: Object.keys(updatedInput!),
      });
    }

    const prompt = this.prompts.get(requestId);
    if (!prompt || prompt.instanceId !== instanceId) {
      this.sendJson(res, 404, { error: 'Prompt not found' });
      return;
    }

    const approved = decisionAction !== 'deny';
    if (prompt.kind === 'user-action') {
      const response = typeof body.response === 'string' ? body.response : undefined;
      this.source().getOrchestrationHandler().respondToUserAction(requestId, approved, response);
      this.clearPrompt(requestId);
      this.sendJson(res, 200, { ok: true, responded: true });
      return;
    }

    const resumeUpdatedInput = decisionAction === 'modify' ? updatedInput : undefined;
    await this.source().resumeAfterDeferredPermission(instanceId, approved, resumeUpdatedInput);
    if (decisionScope) {
      // Map 'modify' to 'allow' for permission record keeping — the modify semantics
      // live at the orchestrator layer; PermissionManager only knows allow/deny.
      const recordAction = decisionAction === 'modify' ? 'allow' : decisionAction;
      this.source().recordInputRequiredPermissionDecision({
        instanceId,
        requestId,
        action: recordAction,
        scope: decisionScope,
      });
    } else {
      this.source().clearPendingInputRequiredPermission(instanceId, requestId);
    }
    this.clearPrompt(requestId);
    this.sendJson(res, 200, { ok: true, resumed: true });
  }

  private handleInterrupt(res: ServerResponse, instanceId: string): void {
    if (!this.source().getInstance(instanceId)) {
      this.sendJson(res, 404, { error: 'Instance not found' });
      return;
    }
    const accepted = this.source().interruptInstance(instanceId);
    this.sendJson(res, 200, { ok: true, accepted });
  }

  private async handleTerminate(
    req: IncomingMessage,
    res: ServerResponse,
    instanceId: string,
  ): Promise<void> {
    const body = (await readJsonBody(req).catch(() => ({}))) as {
      graceful?: unknown;
      idempotencyKey?: unknown;
    };
    // B2: at-most-once — a retried terminate with the same key must not run twice.
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
    if (idempotencyKey && getIdempotencyStore().isDuplicate(
      IdempotencyStore.compose('terminate', instanceId, idempotencyKey),
    )) {
      this.sendJson(res, 200, { ok: true, duplicate: true });
      return;
    }
    const graceful = body.graceful !== false;
    await this.source().terminateInstance(instanceId, graceful);
    this.clearPromptsForInstance(instanceId);
    this.sendJson(res, 200, { ok: true });
  }

  private async handleRename(
    req: IncomingMessage,
    res: ServerResponse,
    instanceId: string,
  ): Promise<void> {
    const body = (await readJsonBody(req)) as { displayName?: unknown };
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName) {
      this.sendJson(res, 400, { error: 'displayName required' });
      return;
    }
    if (!this.source().getInstance(instanceId)) {
      this.sendJson(res, 404, { error: 'Instance not found' });
      return;
    }
    this.source().renameInstance(instanceId, displayName.slice(0, 200));
    this.sendJson(res, 200, { ok: true });
  }

  private async handleCreateInstance(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as {
      workingDirectory?: unknown;
      provider?: unknown;
      model?: unknown;
      initialPrompt?: unknown;
      forceNodeId?: unknown;
      nodeName?: unknown;
    };
    const workingDirectory =
      typeof body.workingDirectory === 'string' ? body.workingDirectory.trim() : '';
    if (!workingDirectory) {
      this.sendJson(res, 400, { error: 'workingDirectory required' });
      return;
    }
    const provider =
      typeof body.provider === 'string' && VALID_PROVIDERS.has(body.provider)
        ? (body.provider as InstanceCreateConfig['provider'])
        : undefined;

    // Optional remote targeting: spawn on a specific worker node. Accept either
    // an explicit node id (`forceNodeId`) or a human-friendly `nodeName` that we
    // resolve to an id. An unresolvable target is a client error rather than a
    // silent fall back to local execution (which would confuse "run on windows").
    let forceNodeId =
      typeof body.forceNodeId === 'string' && body.forceNodeId.trim()
        ? body.forceNodeId.trim()
        : undefined;
    const nodeName = typeof body.nodeName === 'string' ? body.nodeName.trim() : '';
    if (!forceNodeId && nodeName) {
      const resolved = this.resolveNodeId(nodeName);
      if (!resolved) {
        this.sendJson(res, 404, { error: `Worker node not found: ${nodeName}` });
        return;
      }
      forceNodeId = resolved;
    }

    const config: InstanceCreateConfig = {
      workingDirectory,
      initialPrompt: typeof body.initialPrompt === 'string' ? body.initialPrompt : undefined,
      provider,
      modelOverride: typeof body.model === 'string' ? body.model : undefined,
      forceNodeId,
    };
    const instance = await this.source().createInstance(config);
    this.sendJson(res, 200, serializeInstance(instance));
  }

  private async handleSetPause(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as { paused?: unknown };
    if (typeof body.paused !== 'boolean') {
      this.sendJson(res, 400, { error: 'paused (boolean) required' });
      return;
    }
    if (body.paused) {
      this.pause.addReason('user', { source: 'mobile' });
    } else {
      this.pause.removeReason('user');
    }
    this.sendJson(res, 200, this.pauseState());
  }

  private async handleRecentDirs(res: ServerResponse): Promise<void> {
    const entries = await this.recentDirs.getDirectories({ limit: 50 });
    this.sendJson(
      res,
      200,
      entries.map((e) => ({
        path: e.path,
        displayName: e.displayName,
        lastAccessed: e.lastAccessed,
        isPinned: e.isPinned,
      })),
    );
  }

  /**
   * GET /api/history — persisted sessions, newest first. Merges two stores:
   * the ChatService chats (live + archived) and the HistoryManager archive of
   * closed instance sessions (the work run as live agents). Ids are namespaced
   * (`chat:` / `inst:`) so the transcript route can dispatch to the right store.
   * Either store being unavailable degrades to "just the other one".
   */
  private handleHistory(res: ServerResponse): void {
    const sessions: MobileHistorySessionDto[] = [];

    const chatSource = this.chatHistory;
    if (chatSource) {
      try {
        for (const chat of chatSource.listChats({ includeArchived: true })) {
          const dto = serializeHistorySession(chat);
          sessions.push({ ...dto, id: `${HISTORY_CHAT_PREFIX}${dto.id}` });
        }
      } catch (err) {
        logger.warn('Chat history list failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const instanceSource = this.instanceHistory;
    if (instanceSource) {
      try {
        for (const entry of instanceSource.getEntries({ limit: 500 })) {
          const dto = serializeInstanceHistorySession(entry);
          sessions.push({ ...dto, id: `${HISTORY_INSTANCE_PREFIX}${dto.id}` });
        }
      } catch (err) {
        logger.warn('Instance history list failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    this.sendJson(res, 200, sessions);
  }

  /** GET /api/history/:id/messages — transcript of one persisted session (chat or instance). */
  private async handleHistoryMessages(res: ServerResponse, id: string): Promise<void> {
    try {
      if (id.startsWith(HISTORY_INSTANCE_PREFIX)) {
        const source = this.instanceHistory;
        if (!source) {
          this.sendJson(res, 404, { error: 'History unavailable' });
          return;
        }
        const data = await source.loadConversation(id.slice(HISTORY_INSTANCE_PREFIX.length));
        if (!data) {
          this.sendJson(res, 404, { error: 'Session not found' });
          return;
        }
        const messages = (data.messages ?? []).slice(-MESSAGE_REPLAY_LIMIT).map(serializeMessage);
        this.sendJson(res, 200, messages);
        return;
      }

      // Default / `chat:` → the ChatService store.
      const source = this.chatHistory;
      if (!source) {
        this.sendJson(res, 404, { error: 'History unavailable' });
        return;
      }
      const chatId = id.startsWith(HISTORY_CHAT_PREFIX)
        ? id.slice(HISTORY_CHAT_PREFIX.length)
        : id;
      const detail = await source.getChat(chatId);
      const messages = (detail.conversation.messages ?? [])
        .slice(-MESSAGE_REPLAY_LIMIT)
        .map(serializeHistoryMessage);
      this.sendJson(res, 200, messages);
    } catch {
      this.sendJson(res, 404, { error: 'Session not found' });
    }
  }

  private async handleApnsToken(
    req: IncomingMessage,
    res: ServerResponse,
    deviceId: string,
    authedDeviceId: string,
  ): Promise<void> {
    if (deviceId !== authedDeviceId) {
      this.sendJson(res, 403, { error: 'Can only set the APNs token for your own device' });
      return;
    }
    const body = (await readJsonBody(req)) as { apnsToken?: unknown };
    const apnsToken = typeof body.apnsToken === 'string' ? body.apnsToken.trim() : '';
    if (!apnsToken) {
      this.sendJson(res, 400, { error: 'apnsToken required' });
      return;
    }
    const ok = this.registry.setApnsToken(deviceId, apnsToken);
    this.sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Device not found' });
  }

  private async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      this.sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return;
    }
    const pairingToken =
      typeof (body as Record<string, unknown>)?.['pairingToken'] === 'string'
        ? ((body as Record<string, unknown>)['pairingToken'] as string)
        : '';
    const label =
      typeof (body as Record<string, unknown>)?.['label'] === 'string'
        ? ((body as Record<string, unknown>)['label'] as string)
        : undefined;

    const result = this.registry.pair({ pairingToken, label });
    if (result.status === 'rejected') {
      this.sendJson(res, 403, { error: result.reason });
      return;
    }
    this.sendJson(res, 200, {
      deviceId: result.device.deviceId,
      token: result.device.token,
      expiresAt: result.device.expiresAt,
      hostName: os.hostname(),
    });
  }

  private sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(),
    });
    res.end(JSON.stringify(payload));
  }
}

export function getMobileGatewayServer(): MobileGatewayServer {
  return MobileGatewayServer.getInstance();
}
