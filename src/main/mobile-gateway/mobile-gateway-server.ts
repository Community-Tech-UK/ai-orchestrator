import * as os from "os";
import { readFileSync } from "fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";
import { createServer as createHttpsServer } from "https";
import type { AddressInfo } from "net";
import { URL } from "url";
import { WebSocketServer, WebSocket } from "ws";
import type {
  MobileGatewayStatus,
  MobilePauseDto,
  MobileSnapshot,
} from "../../shared/types/mobile-gateway.types";
import { getLogger } from "../logging/logger";
import { getPauseCoordinator } from "../pause/pause-coordinator";
import { getRecentDirectoriesManager } from "../core/config/recent-directories-manager";
import { getLoopCoordinator } from "../orchestration/loop-coordinator";
import { resolveBindHost } from "./tailscale-interface";
import {
  getMobileDeviceRegistry,
  type MobileDeviceRegistry,
} from "./mobile-device-registry";
import {
  getMobileApnsSender,
  type MobileApnsSender,
} from "./mobile-apns-sender";
import {
  bearerFromHeader,
  corsHeaders,
  extractCertHostname,
  readJsonBody,
  sendJsonResponse,
} from "./mobile-gateway-http-utils";
import {
  handleMobileHistory,
  handleMobileHistoryMessages,
} from "./mobile-gateway-history-handlers";
import {
  closeSocketsForDevice,
  handleWsUpgrade,
  isInstanceBeingViewed,
  type WsHandlerDeps,
} from "./mobile-gateway-ws-handlers";
import type {
  GatewayChatHistorySource,
  GatewayInstanceHistorySource,
} from "./mobile-gateway-serializers";
import {
  clearMobilePushThrottle,
  sendMobileAutomationFailurePush,
  sendBrowserEscalationPush,
  sendMobileCompletionPush,
  sendMobileLiveActivityPush,
  sendMobilePromptPush,
  type BrowserEscalationPushInput,
} from "./mobile-gateway-push";
import { handleMobileDeviceRoutes } from "./mobile-gateway-device-token-handlers";
import type {
  MobileModelCatalogSource,
  MobileModelLister,
} from "./mobile-gateway-model-handlers";
import {
  MobileGatewayInstanceRoutes,
  type GatewayInstanceSource,
} from "./mobile-gateway-instance-routes";
import {
  MobileGatewayEvents,
  type GatewayLoopSource,
  type GatewayPauseSource,
} from "./mobile-gateway-events";
import { MobileGatewayPromptStore } from "./mobile-gateway-prompt-store";
import { MobileGatewaySnapshotService } from "./mobile-gateway-snapshot";
import { MobileGatewayStreamCursor } from "./mobile-gateway-stream-cursor";
import { MobileGatewayQuotaHandlers, type GatewayQuotaSource } from "./mobile-gateway-quota-handlers";
import { getProviderQuotaService } from "../core/system/provider-quota-service";
import { sendMobileQuotaPush } from "./mobile-gateway-push";
import {
  MobileAutomationRequestError,
  MobileGatewayAutomationHandlers,
  readMobileAutomationRunRequest,
  type GatewayAutomationEvents,
  type GatewayAutomationRunner,
  type GatewayAutomationStore,
} from './mobile-gateway-automation-handlers';
import { getAutomationRunner, getAutomationStore } from '../automations';
import { getAutomationEvents } from '../automations/automation-events';
import {
  readAutomationModelDefaults,
  type AutomationModelDefaults,
} from '../automations/automation-model-defaults';

export {
  buildProjects,
  serializeHistoryMessage,
  serializeHistorySession,
  serializeInstance,
  serializeInstanceHistorySession,
} from "./mobile-gateway-serializers";
export { extractCertHostname } from "./mobile-gateway-http-utils";
export type { GatewayInstanceSource } from "./mobile-gateway-instance-routes";
export type {
  GatewayLoopSource,
  GatewayPauseSource,
} from "./mobile-gateway-events";
export type {
  GatewayChatHistorySource,
  GatewayHistoryChat,
  GatewayHistoryMessage,
  GatewayInstanceHistoryEntry,
  GatewayInstanceHistorySource,
} from "./mobile-gateway-serializers";

const logger = getLogger("MobileGateway");
const MESSAGE_REPLAY_LIMIT = 300;
const WS_HEARTBEAT_MS = 30_000;

export interface GatewayRecentDirsSource {
  getDirectories(options?: {
    limit?: number;
  }): Promise<
    {
      path: string;
      displayName: string;
      lastAccessed: number;
      isPinned: boolean;
    }[]
  >;
}

export interface MobileGatewayDeps {
  instanceManager: GatewayInstanceSource;
  registry?: MobileDeviceRegistry;
  pauseCoordinator?: GatewayPauseSource;
  recentDirs?: GatewayRecentDirsSource;
  chatHistory?: GatewayChatHistorySource;
  instanceHistory?: GatewayInstanceHistorySource;
  loopCoordinator?: GatewayLoopSource;
  apnsSender?: MobileApnsSender;
  modelCatalog?: MobileModelCatalogSource;
  listDynamicModels?: MobileModelLister;
  nodeResolver?: (nameOrId: string) => string | null;
  quotaSource?: GatewayQuotaSource;
  automationStore?: GatewayAutomationStore;
  automationRunner?: GatewayAutomationRunner;
  automationEvents?: GatewayAutomationEvents;
  automationModelDefaults?: () => AutomationModelDefaults;
}

export interface MobileGatewayStartOptions {
  port: number;
  bindInterface: "tailscale" | "all";
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

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
  private readonly clientAlive = new WeakMap<WebSocket, boolean>();
  private readonly activeViewByClient = new Map<WebSocket, string>();
  private readonly deviceIdByClient = new Map<WebSocket, string>();
  private boundHost = "";
  private boundPort = 0;
  private tailscaleIp: string | null = null;
  private secure = false;
  private tlsHostname: string | null = null;
  private startedAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeRevocations: (() => void) | null = null;
  private readonly streamCursor = new MobileGatewayStreamCursor();
  private readonly quota = new MobileGatewayQuotaHandlers({
    getSource: () => this.deps?.quotaSource ?? getProviderQuotaService(),
    broadcast: event => this.snapshots.broadcast(event),
    sendExhaustedPush: () => sendMobileQuotaPush(this.pushDeps()),
  });
  private readonly automations = new MobileGatewayAutomationHandlers({
    getStore: () => this.deps?.automationStore ?? getAutomationStore(),
    getRunner: () => this.deps?.automationRunner ?? getAutomationRunner(),
    getEvents: () => this.deps?.automationEvents ?? getAutomationEvents(),
    getModelDefaults: () => this.deps?.automationModelDefaults?.() ?? readAutomationModelDefaults(),
    sendFailedPush: failure => sendMobileAutomationFailurePush(this.pushDeps(), failure),
  });

  private readonly promptStore = new MobileGatewayPromptStore({
    broadcast: (event) => this.snapshots.broadcast(event),
    scheduleSnapshotBroadcast: () => this.snapshots.scheduleBroadcast(),
    sendPush: (prompt) => sendMobilePromptPush(this.pushDeps(), prompt),
  });

  private readonly instanceRoutes: MobileGatewayInstanceRoutes = new MobileGatewayInstanceRoutes({
    getInstanceSource: () => this.source(),
    getPauseState: () => this.pauseState(),
    promptStore: this.promptStore,
    streamCursor: this.streamCursor,
    markCompletionViewed: (instanceId) =>
      this.events.markCompletionViewed(instanceId),
    scheduleSnapshotBroadcast: () => this.snapshots.scheduleBroadcast(),
    buildSnapshotInstances: () => this.snapshots.buildSnapshot().instances,
    serializeInstance: (instance) => this.snapshots.serializeInstance(instance),
    resolveNodeId: (nameOrId) => this.resolveNodeId(nameOrId),
    getModelCatalog: () => this.deps?.modelCatalog,
    getListDynamicModels: () => this.deps?.listDynamicModels,
    logger,
  });

  private readonly snapshots: MobileGatewaySnapshotService = new MobileGatewaySnapshotService({
    clients: this.clients,
    isRunning: () => this.isRunning(),
    getInstances: () => this.deps?.instanceManager.getAllInstances() ?? [],
    getPrompts: () => this.promptStore.values(),
    getPauseState: () => this.pauseState(),
    getActiveLoops: () => this.loopCoordinator?.getActiveLoops() ?? [],
    hasUnreadCompletion: (instanceId) =>
      this.events.hasUnreadCompletion(instanceId),
    getQueuedMessages: (instanceId) =>
      this.instanceRoutes.queuedMessages(instanceId),
    debug: (message, data) => logger.debug(message, data),
  });

  private readonly events = new MobileGatewayEvents({
    getInstanceSource: () => this.source(),
    getPauseSource: () => this.pause,
    getLoopSource: () => this.loopCoordinator,
    getPauseState: () => this.pauseState(),
    promptStore: this.promptStore,
    streamCursor: this.streamCursor,
    hasClients: () => this.clients.size > 0,
    broadcast: (event) => this.snapshots.broadcast(event),
    scheduleSnapshotBroadcast: () => this.snapshots.scheduleBroadcast(),
    isInstanceBeingViewed: (instanceId) =>
      isInstanceBeingViewed(this.wsDeps(), instanceId),
    clearInstanceQueue: (instanceId) =>
      this.instanceRoutes.clearInstance(instanceId),
    clearSendInFlight: (instanceId) =>
      this.instanceRoutes.clearSendInFlight(instanceId),
    drainQueue: (instanceId) => this.instanceRoutes.drain(instanceId),
    drainAllQueues: () => this.instanceRoutes.drainAll(),
    sendCompletionPush: (instanceId) =>
      sendMobileCompletionPush(this.pushDeps(), instanceId),
    sendLiveActivityPush: (instanceId, status, event) =>
      sendMobileLiveActivityPush(this.pushDeps(), instanceId, status, event),
    clearLiveActivityTokens: (instanceId) =>
      this.registry.clearLiveActivityTokensForInstance(instanceId),
    warn: (message, data) => logger.warn(message, data),
  });

  static getInstance(): MobileGatewayServer {
    if (!this.instance) this.instance = new MobileGatewayServer();
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) void this.instance.stop();
    this.instance = null;
  }

  initialize(deps: MobileGatewayDeps): void {
    this.deps = deps;
  }

  private get registry(): MobileDeviceRegistry {
    return this.deps?.registry ?? getMobileDeviceRegistry();
  }

  private get pause(): GatewayPauseSource {
    return (
      this.deps?.pauseCoordinator ??
      (getPauseCoordinator() as unknown as GatewayPauseSource)
    );
  }

  private get recentDirs(): GatewayRecentDirsSource {
    return this.deps?.recentDirs ?? getRecentDirectoriesManager();
  }

  private get loopCoordinator(): GatewayLoopSource | null {
    return this.deps?.loopCoordinator ?? getLoopCoordinator();
  }

  private get chatHistory(): GatewayChatHistorySource | null {
    if (this.deps?.chatHistory) return this.deps.chatHistory;
    if (!this.deps?.instanceManager) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getChatService } =
        require("../chats") as typeof import("../chats");
      return getChatService({
        instanceManager: this.deps.instanceManager as unknown as Parameters<
          typeof getChatService
        >[0]["instanceManager"],
      }) as unknown as GatewayChatHistorySource;
    } catch {
      return null;
    }
  }

  private get instanceHistory(): GatewayInstanceHistorySource | null {
    if (this.deps?.instanceHistory) return this.deps.instanceHistory;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getHistoryManager } =
        require("../history/history-manager") as typeof import("../history/history-manager");
      return getHistoryManager() as unknown as GatewayInstanceHistorySource;
    } catch {
      return null;
    }
  }

  private get apnsSender(): MobileApnsSender {
    return this.deps?.apnsSender ?? getMobileApnsSender();
  }

  async start(
    options: MobileGatewayStartOptions,
  ): Promise<MobileGatewayStatus> {
    if (this.httpServer) return this.getStatus();
    if (!this.deps)
      throw new Error("Mobile gateway dependencies have not been initialized.");

    const { host, tailscaleIp } = resolveBindHost(options.bindInterface);
    this.tailscaleIp = tailscaleIp;
    const tls = this.resolveTls(options.tlsCertPath, options.tlsKeyPath);
    this.secure = tls !== null;
    this.tlsHostname = tls?.hostname ?? null;
    const requestHandler = (
      req: IncomingMessage,
      res: ServerResponse,
    ): void => {
      void this.handleRequest(req, res);
    };
    const httpServer = tls
      ? createHttpsServer({ cert: tls.cert, key: tls.key }, requestHandler)
      : createServer(requestHandler);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.unsubscribeRevocations?.();
    this.unsubscribeRevocations = this.registry.onDeviceRevoked((deviceId) =>
      closeSocketsForDevice(this.wsDeps(), deviceId),
    );
    httpServer.on("upgrade", (req, socket, head) =>
      handleWsUpgrade(this.wsDeps(), req, socket, head),
    );

    await new Promise<void>((resolve, reject) => {
      httpServer.on("error", reject);
      httpServer.listen(options.port, host, () => {
        this.httpServer = httpServer;
        const address = httpServer.address() as AddressInfo | null;
        this.boundHost = host;
        this.boundPort = address?.port ?? options.port;
        this.startedAt = Date.now();
        resolve();
      });
    });
    this.events.attach();
    this.quota.attach();
    this.automations.attach();
    this.startHeartbeat();
    logger.info("Mobile gateway started", {
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
    this.automations.detach();
    this.quota.detach();
    this.snapshots.stop();
    clearMobilePushThrottle();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.deps) this.events.detach();
    for (const client of this.clients) {
      try {
        client.close(1001, "Server shutting down");
      } catch {
        // Already gone.
      }
    }
    this.clients.clear();
    this.activeViewByClient.clear();
    this.promptStore.clearAll();
    this.instanceRoutes.clearAll();
    this.streamCursor.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.info("Mobile gateway stopped");
    }
    this.unsubscribeRevocations?.();
    this.unsubscribeRevocations = null;
    this.deviceIdByClient.clear();
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
    const scheme = this.secure ? "wss" : "ws";
    const urlHost = this.secure
      ? (this.tlsHostname ?? this.tailscaleIp)
      : this.tailscaleIp;
    return {
      running,
      host: running ? this.boundHost : undefined,
      port: running ? this.boundPort : undefined,
      tailscaleIp: this.tailscaleIp,
      secure: this.secure,
      tlsHostname: this.tlsHostname,
      tailnetUrl:
        running && urlHost
          ? `${scheme}://${urlHost}:${this.boundPort}/ws`
          : undefined,
      startedAt: running ? this.startedAt : undefined,
      connectedClientCount: this.clients.size,
      pairedDeviceCount: this.registry.deviceCount(),
      pushConfigured: this.safeIsPushConfigured(),
    };
  }

  buildSnapshot(): MobileSnapshot {
    return this.snapshots.buildSnapshot();
  }

  notifyBrowserEscalation(escalation: BrowserEscalationPushInput): void {
    sendBrowserEscalationPush(this.pushDeps(), escalation);
  }

  private source(): GatewayInstanceSource {
    if (!this.deps) throw new Error("Gateway not initialized");
    return this.deps.instanceManager;
  }

  private resolveNodeId(nameOrId: string): string | null {
    if (this.deps?.nodeResolver) return this.deps.nodeResolver(nameOrId);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getWorkerNodeRegistry } = require("../remote-node");
      const node = getWorkerNodeRegistry()
        .getAllNodes()
        .find(
          (entry: { id: string; name: string }) =>
            entry.id === nameOrId || entry.name === nameOrId,
        );
      return node?.id ?? null;
    } catch {
      return null;
    }
  }

  private resolveTls(certPath?: string, keyPath?: string): ResolvedTls | null {
    const certFile = certPath?.trim();
    const keyFile = keyPath?.trim();
    if (!certFile || !keyFile) return null;
    try {
      const cert = readFileSync(certFile);
      const key = readFileSync(keyFile);
      return {
        cert,
        key,
        hostname: extractCertHostname(cert.toString("utf-8")),
      };
    } catch (error) {
      logger.warn(
        "Mobile gateway TLS configured but cert/key unreadable — falling back to ws://",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return null;
    }
  }

  private safeIsPushConfigured(): boolean {
    try {
      return this.apnsSender.isConfigured();
    } catch {
      return false;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (this.clientAlive.get(client) === false) {
          this.clients.delete(client);
          this.activeViewByClient.delete(client);
          try {
            client.terminate();
          } catch {
            // Already gone.
          }
          continue;
        }
        this.clientAlive.set(client, false);
        try {
          client.ping();
        } catch {
          // The next heartbeat will reap it.
        }
      }
    }, WS_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private pauseState(): MobilePauseDto {
    try {
      return this.pause.toPayload();
    } catch {
      return { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 };
    }
  }

  private pushDeps() {
    return {
      apnsSender: this.apnsSender,
      registry: this.registry,
      instanceManager: this.deps?.instanceManager ?? null,
      logger,
    };
  }

  private wsDeps(): WsHandlerDeps {
    return {
      registry: this.registry,
      wss: this.wss,
      clients: this.clients,
      clientAlive: this.clientAlive,
      activeViewByClient: this.activeViewByClient,
      deviceIdByClient: this.deviceIdByClient,
      buildSnapshot: () => this.snapshots.buildSnapshot(),
      markCompletionViewed: (instanceId) =>
        this.events.markCompletionViewed(instanceId),
    };
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      req.url || "/",
      `http://${this.boundHost || "localhost"}:${this.boundPort}`,
    );
    const method = req.method || "GET";
    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (url.pathname === "/health") {
      this.sendJson(res, 200, { ok: true, running: this.isRunning() });
      return;
    }
    if (url.pathname === "/pair" && method === "POST") {
      await this.handlePair(req, res);
      return;
    }
    const device = this.registry.validateToken(
      bearerFromHeader(req.headers["authorization"]),
    );
    if (!device) {
      this.sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    try {
      if (segments[0] === "api") {
        if (segments[1] === 'automations' && segments.length === 2 && method === 'GET') {
          return this.sendJson(res, 200, await this.automations.list());
        }
        if (segments[1] === 'automations' && segments.length === 4 && segments[3] === 'run' && method === 'POST') {
          const body = await readMobileAutomationRunRequest(req);
          let automationId: string;
          try {
            automationId = decodeURIComponent(segments[2]);
          } catch {
            throw new MobileAutomationRequestError('A valid automation id is required');
          }
          const result = await this.automations.run(automationId, body);
          return this.sendJson(res, 200, result);
        }
        if (segments[1] === "quota" && segments.length === 2 && method === "GET") {
          return this.sendJson(res, 200, this.quota.read());
        }
        if (await this.instanceRoutes.handle(req, res, url, segments, method))
          return;
        if (
          segments[1] === "projects" &&
          segments.length === 2 &&
          method === "GET"
        ) {
          return this.sendJson(
            res,
            200,
            this.snapshots.buildSnapshot().projects,
          );
        }
        if (
          segments[1] === "snapshot" &&
          segments.length === 2 &&
          method === "GET"
        ) {
          return this.sendJson(res, 200, this.snapshots.buildSnapshot());
        }
        if (
          segments[1] === "prompts" &&
          segments.length === 2 &&
          method === "GET"
        ) {
          return this.sendJson(res, 200, this.promptStore.values());
        }
        if (segments[1] === "pause" && segments.length === 2) {
          if (method === "GET")
            return this.sendJson(res, 200, this.pauseState());
          if (method === "POST") return await this.handleSetPause(req, res);
        }
        if (
          segments[1] === "recent-dirs" &&
          segments.length === 2 &&
          method === "GET"
        ) {
          return await this.handleRecentDirs(res);
        }
        if (segments[1] === "history" && method === "GET") {
          if (segments.length === 2) return this.handleHistory(res);
          if (segments.length === 4 && segments[3] === "messages") {
            return await this.handleHistoryMessages(
              res,
              decodeURIComponent(segments[2]),
              url,
            );
          }
        }
        if (
          await handleMobileDeviceRoutes(
            this.deviceTokenDeps(),
            req,
            res,
            segments,
            method,
            device.deviceId,
          )
        )
          return;
      }
      this.sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      logger.warn("Request handler error", {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      this.sendJson(res, error instanceof MobileAutomationRequestError ? error.statusCode : 500, {
        error: error instanceof Error ? error.message : "Internal error",
      });
    }
  }

  private async handleSetPause(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = (await readJsonBody(req)) as { paused?: unknown };
    if (typeof body.paused !== "boolean") {
      this.sendJson(res, 400, { error: "paused (boolean) required" });
      return;
    }
    if (body.paused) this.pause.addReason("user", { source: "mobile" });
    else this.pause.removeReason("user");
    this.sendJson(res, 200, this.pauseState());
  }

  private async handleRecentDirs(res: ServerResponse): Promise<void> {
    const entries = await this.recentDirs.getDirectories({ limit: 50 });
    this.sendJson(
      res,
      200,
      entries.map((entry) => ({
        path: entry.path,
        displayName: entry.displayName,
        lastAccessed: entry.lastAccessed,
        isPinned: entry.isPinned,
      })),
    );
  }

  private handleHistory(res: ServerResponse): void {
    handleMobileHistory(this.historyDeps(), res);
  }

  private async handleHistoryMessages(
    res: ServerResponse,
    id: string,
    url: URL,
  ): Promise<void> {
    await handleMobileHistoryMessages(this.historyDeps(), res, id, url);
  }

  private historyDeps() {
    return {
      chatHistory: this.chatHistory,
      instanceHistory: this.instanceHistory,
      messageReplayLimit: MESSAGE_REPLAY_LIMIT,
      sendJson: (
        response: ServerResponse,
        statusCode: number,
        payload: unknown,
      ) => this.sendJson(response, statusCode, payload),
      logger,
    };
  }

  private deviceTokenDeps() {
    return {
      registry: this.registry,
      sendJson: (res: ServerResponse, statusCode: number, payload: unknown) =>
        this.sendJson(res, statusCode, payload),
    };
  }

  private async handlePair(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      this.sendJson(res, 400, {
        error: error instanceof Error ? error.message : "Invalid body",
      });
      return;
    }
    const pairingToken =
      typeof (body as Record<string, unknown>)?.["pairingToken"] === "string"
        ? ((body as Record<string, unknown>)["pairingToken"] as string)
        : "";
    const label =
      typeof (body as Record<string, unknown>)?.["label"] === "string"
        ? ((body as Record<string, unknown>)["label"] as string)
        : undefined;
    const result = this.registry.pair({ pairingToken, label });
    if (result.status === "rejected") {
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

  private sendJson(
    res: ServerResponse,
    statusCode: number,
    payload: unknown,
  ): void {
    sendJsonResponse(res, statusCode, payload);
  }
}

export function getMobileGatewayServer(): MobileGatewayServer {
  return MobileGatewayServer.getInstance();
}
