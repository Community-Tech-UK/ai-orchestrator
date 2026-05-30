import * as os from 'os';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';
import { URL } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { crossPlatformBasename } from '../../shared/utils/cross-platform-path';
import { getLogger } from '../logging/logger';
import { resolveBindHost } from './tailscale-interface';
import { getMobileDeviceRegistry, type MobileDeviceRegistry } from './mobile-device-registry';
import type { Instance } from '../../shared/types/instance.types';
import type {
  MobileGatewayStatus,
  MobileInstanceDto,
  MobileProjectDto,
  MobileServerEvent,
  MobileSnapshot,
} from '../../shared/types/mobile-gateway.types';

const logger = getLogger('MobileGateway');

const NO_WORKSPACE_KEY = '__no_workspace__';
const MAX_BODY_BYTES = 64 * 1024;
const SNAPSHOT_COALESCE_MS = 100;

/** Statuses that count as "actively working" for the project rollup. */
const WORKING_STATUSES = new Set<string>([
  'initializing',
  'busy',
  'processing',
  'thinking_deeply',
  'interrupting',
  'interrupt-escalating',
  'cancelling',
  'respawning',
  'waking',
]);

/**
 * Minimal structural view of InstanceManager the gateway needs. The real
 * InstanceManager (an EventEmitter) satisfies this, and tests can pass a light
 * double without constructing the whole manager.
 */
export interface GatewayInstanceSource {
  getAllInstances(): Instance[];
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface MobileGatewayDeps {
  instanceManager: GatewayInstanceSource;
  /** Defaults to the settings-backed singleton; injectable for tests. */
  registry?: MobileDeviceRegistry;
}

export interface MobileGatewayStartOptions {
  port: number;
  bindInterface: 'tailscale' | 'all';
}

export function serializeInstance(instance: Instance): MobileInstanceDto {
  const workingDirectory = instance.workingDirectory || '';
  return {
    id: instance.id,
    displayName: instance.displayName,
    status: instance.status,
    provider: instance.provider,
    model: instance.currentModel,
    workingDirectory,
    projectName: workingDirectory
      ? crossPlatformBasename(workingDirectory) || workingDirectory
      : 'No workspace',
    createdAt: instance.createdAt,
    lastActivity: instance.lastActivity,
    parentId: instance.parentId ?? undefined,
    // The backend Instance has no approval/unread fields (those are renderer-
    // derived); Phase 0 infers approval from status. Phase 2 wires the real
    // pending-prompt store.
    pendingApprovalCount: instance.status === 'waiting_for_permission' ? 1 : 0,
    hasUnreadCompletion: false,
    contextPercentage: instance.contextUsage?.percentage,
  };
}

export function buildProjects(instances: MobileInstanceDto[]): MobileProjectDto[] {
  const map = new Map<string, MobileProjectDto>();
  for (const inst of instances) {
    const key = inst.workingDirectory || NO_WORKSPACE_KEY;
    let proj = map.get(key);
    if (!proj) {
      proj = {
        key,
        path: inst.workingDirectory,
        name: inst.workingDirectory ? inst.projectName : 'No workspace',
        sessionCount: 0,
        busyCount: 0,
        pendingApprovalCount: 0,
        lastActivity: 0,
      };
      map.set(key, proj);
    }
    proj.sessionCount += 1;
    if (WORKING_STATUSES.has(inst.status)) proj.busyCount += 1;
    proj.pendingApprovalCount += inst.pendingApprovalCount;
    proj.lastActivity = Math.max(proj.lastActivity, inst.lastActivity);
  }
  return [...map.values()].sort((a, b) => b.lastActivity - a.lastActivity);
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
  private startedAt = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onInstanceChange = () => this.scheduleSnapshotBroadcast();

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

  async start(options: MobileGatewayStartOptions): Promise<MobileGatewayStatus> {
    if (this.httpServer) {
      return this.getStatus();
    }
    if (!this.deps) {
      throw new Error('Mobile gateway dependencies have not been initialized.');
    }

    const { host, tailscaleIp } = resolveBindHost(options.bindInterface);
    this.tailscaleIp = tailscaleIp;

    const httpServer = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
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

    const { instanceManager } = this.deps;
    instanceManager.on('instance:created', this.onInstanceChange);
    instanceManager.on('instance:removed', this.onInstanceChange);
    instanceManager.on('instance:state-update', this.onInstanceChange);
    instanceManager.on('instance:batch-update', this.onInstanceChange);

    logger.info('Mobile gateway started', {
      host: this.boundHost,
      port: this.boundPort,
      tailscaleIp: this.tailscaleIp,
    });
    return this.getStatus();
  }

  async stop(): Promise<MobileGatewayStatus> {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (this.deps) {
      const { instanceManager } = this.deps;
      instanceManager.removeListener('instance:created', this.onInstanceChange);
      instanceManager.removeListener('instance:removed', this.onInstanceChange);
      instanceManager.removeListener('instance:state-update', this.onInstanceChange);
      instanceManager.removeListener('instance:batch-update', this.onInstanceChange);
    }

    for (const client of this.clients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();

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
    return this.getStatus();
  }

  isRunning(): boolean {
    return this.httpServer !== null;
  }

  getStatus(): MobileGatewayStatus {
    const running = this.isRunning();
    return {
      running,
      host: running ? this.boundHost : undefined,
      port: running ? this.boundPort : undefined,
      tailscaleIp: this.tailscaleIp,
      tailnetUrl:
        running && this.tailscaleIp ? `ws://${this.tailscaleIp}:${this.boundPort}/ws` : undefined,
      startedAt: running ? this.startedAt : undefined,
      connectedClientCount: this.clients.size,
      pairedDeviceCount: this.registry.deviceCount(),
    };
  }

  // ---------------------------------------------------------------------------
  // Snapshot building
  // ---------------------------------------------------------------------------

  buildSnapshot(): MobileSnapshot {
    const instances = (this.deps?.instanceManager.getAllInstances() ?? [])
      .filter((instance) => instance.status !== 'terminated')
      .map(serializeInstance);
    return {
      hostName: os.hostname(),
      serverTime: Date.now(),
      instances,
      projects: buildProjects(instances),
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
    ws.on('close', () => {
      this.clients.delete(ws);
    });
    ws.on('error', () => {
      this.clients.delete(ws);
    });
    // Initial snapshot.
    ws.send(JSON.stringify({ type: 'snapshot', data: this.buildSnapshot() } satisfies MobileServerEvent));
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${this.boundHost || 'localhost'}:${this.boundPort}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      this.sendJson(res, 200, { ok: true, running: this.isRunning() });
      return;
    }

    if (url.pathname === '/pair' && req.method === 'POST') {
      await this.handlePair(req, res);
      return;
    }

    // Everything below requires a valid device token.
    const device = this.registry.validateToken(bearerFromHeader(req.headers['authorization']));
    if (!device) {
      this.sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (url.pathname === '/api/instances' && req.method === 'GET') {
      this.sendJson(res, 200, this.buildSnapshot().instances);
      return;
    }

    if (url.pathname === '/api/projects' && req.method === 'GET') {
      this.sendJson(res, 200, this.buildSnapshot().projects);
      return;
    }

    if (url.pathname === '/api/snapshot' && req.method === 'GET') {
      this.sendJson(res, 200, this.buildSnapshot());
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }

  private async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      this.sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return;
    }
    const pairingToken = typeof (body as Record<string, unknown>)?.['pairingToken'] === 'string'
      ? ((body as Record<string, unknown>)['pairingToken'] as string)
      : '';
    const label = typeof (body as Record<string, unknown>)?.['label'] === 'string'
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

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

function bearerFromHeader(authHeader: string | string[] | undefined): string | undefined {
  const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (typeof value === 'string' && value.startsWith('Bearer ')) {
    return value.slice('Bearer '.length).trim();
  }
  return undefined;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function getMobileGatewayServer(): MobileGatewayServer {
  return MobileGatewayServer.getInstance();
}
