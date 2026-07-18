import * as path from 'path';
import { randomUUID } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { URL } from 'url';
import { crossPlatformBasename } from '../../shared/utils/cross-platform-path';
import type { InstanceManager } from '../instance/instance-manager';
import { getLogger } from '../logging/logger';
import { getWorkerNodeRegistry } from '../remote-node';
import { getRepoJobService } from '../repo-jobs';
import { getSessionShareService } from '../session/session-share-service';
import { getLocalIpv4Addresses } from '../util/network-addresses';
import type {
  RemoteObserverEventEnvelope,
  RemoteObserverInstanceSummary,
  RemoteObserverPrompt,
  RemoteObserverSnapshot,
  RemoteObserverStatus,
} from '../../shared/types/remote-observer.types';
import { OBSERVER_CLIENT_SCRIPT } from './observer-client-script';
import { getRemoteObserverAuth } from './observer-auth';
import { buildObserverPageResponse } from './observer-page';
import { OBSERVER_STYLES } from './observer-styles';

const logger = getLogger('RemoteObserverServer');

interface RemoteObserverServerDeps {
  instanceManager: InstanceManager;
}

interface ServerState {
  host: string;
  port?: number;
  startedAt?: number;
  lastEventAt?: number;
}

type SseClient = ServerResponse<IncomingMessage> & { __observerId?: string };

export class RemoteObserverServer {
  private static instance: RemoteObserverServer | null = null;

  private deps: RemoteObserverServerDeps | null = null;
  private server: Server | null = null;
  private readonly clients = new Set<SseClient>();
  private readonly prompts = new Map<string, RemoteObserverPrompt>();
  private state: ServerState = { host: '127.0.0.1' };

  static getInstance(): RemoteObserverServer {
    if (!this.instance) {
      this.instance = new RemoteObserverServer();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  initialize(deps: RemoteObserverServerDeps): void {
    this.deps = deps;
  }

  async start(host = '127.0.0.1', port = 4877): Promise<RemoteObserverStatus> {
    if (this.server) {
      return this.getStatus();
    }

    if (!this.deps) {
      throw new Error('Remote observer server dependencies have not been initialized.');
    }

    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      server.on('error', reject);
      server.listen(port, host, () => {
        this.server = server;
        this.state = {
          host,
          port,
          startedAt: Date.now(),
          lastEventAt: undefined,
        };
        resolve();
      });
    });

    logger.info('Started remote observer server', { host, port });
    this.broadcast('status', this.buildSnapshot());
    return this.getStatus();
  }

  async stop(): Promise<RemoteObserverStatus> {
    if (!this.server) {
      return this.getStatus();
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    this.server = null;
    this.state = { host: this.state.host };
    logger.info('Stopped remote observer server');
    return this.getStatus();
  }

  async rotateToken(): Promise<RemoteObserverStatus> {
    getRemoteObserverAuth().rotateToken();
    this.broadcast('status', this.buildSnapshot());
    return this.getStatus();
  }

  getStatus(): RemoteObserverStatus {
    return {
      running: Boolean(this.server),
      mode: 'read-only',
      host: this.state.host,
      port: this.state.port,
      token: getRemoteObserverAuth().getToken(),
      startedAt: this.state.startedAt,
      observerUrls: this.buildObserverUrls(),
      instanceCount: this.listInstances().length,
      jobCount: getRepoJobService().listJobs().length,
      pendingPromptCount: this.prompts.size,
      lastEventAt: this.state.lastEventAt,
    };
  }

  recordPrompt(prompt: RemoteObserverPrompt): void {
    this.prompts.set(prompt.id, prompt);
    this.broadcast('permission-prompt', prompt);
  }

  clearPrompt(promptId: string): void {
    if (!this.prompts.delete(promptId)) {
      return;
    }
    this.broadcast('status', this.buildSnapshot());
  }

  publishInstanceOutput(instanceId: string, message: { type: string; content: string; timestamp: number; id?: string }): void {
    const instance = this.deps?.instanceManager.getInstance(instanceId);
    this.broadcast('instance-output', {
      instanceId,
      message: sanitizeMessagePayload(message, instance?.workingDirectory),
    });
  }

  publishInstanceState(update: Record<string, unknown>): void {
    this.broadcast('instance-state', update);
  }

  publishRepoJob(job: unknown): void {
    this.broadcast('repo-job', job as Record<string, unknown>);
  }

  private buildSnapshot(): RemoteObserverSnapshot {
    return {
      status: this.getStatus(),
      instances: this.listInstances(),
      jobs: getRepoJobService().listJobs({ limit: 50 }),
      pendingPrompts: Array.from(this.prompts.values()).sort((a, b) => b.createdAt - a.createdAt),
      workerNodes: getWorkerNodeRegistry().getAllNodes(),
    };
  }

  private listInstances(): RemoteObserverInstanceSummary[] {
    if (!this.deps) {
      return [];
    }

    return this.deps.instanceManager.getAllInstances().map((instance) => ({
      id: instance.id,
      displayName: instance.displayName,
      status: instance.status,
      provider: instance.provider,
      model: instance.currentModel,
      createdAt: instance.createdAt,
      lastActivity: instance.lastActivity,
      workingDirectoryLabel: sanitizeWorkingDirectory(instance.workingDirectory),
    }));
  }

  private buildObserverUrls(): string[] {
    if (!this.state.port) {
      return [];
    }

    const token = getRemoteObserverAuth().getToken();
    const urls = new Set<string>();
    urls.add(`http://${this.state.host}:${this.state.port}/?token=${token}`);

    if (this.state.host === '0.0.0.0') {
      for (const ip of getLocalIpv4Addresses()) {
        urls.add(`http://${ip}:${this.state.port}/?token=${token}`);
      }
    }

    return Array.from(urls);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const baseUrl = `http://${this.state.host || '127.0.0.1'}:${this.state.port || 0}`;
    const url = new URL(req.url || '/', baseUrl);

    if (url.pathname === '/health') {
      this.sendJson(res, 200, { ok: true, running: Boolean(this.server) });
      return;
    }

    if (url.pathname === '/') {
      this.sendObserverPage(res);
      return;
    }

    if (url.pathname === '/observer-client.js') {
      this.sendStaticAsset(res, 'application/javascript; charset=utf-8', OBSERVER_CLIENT_SCRIPT);
      return;
    }

    if (url.pathname === '/observer.css') {
      this.sendStaticAsset(res, 'text/css; charset=utf-8', OBSERVER_STYLES);
      return;
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!this.isAuthorized(req, url)) {
      this.sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (url.pathname === '/api/status') {
      this.sendJson(res, 200, this.getStatus());
      return;
    }

    if (url.pathname === '/api/snapshot') {
      this.sendJson(res, 200, this.buildSnapshot());
      return;
    }

    if (url.pathname === '/api/instances') {
      this.sendJson(res, 200, this.listInstances());
      return;
    }

    if (url.pathname === '/api/jobs') {
      this.sendJson(res, 200, getRepoJobService().listJobs({ limit: 100 }));
      return;
    }

    if (url.pathname === '/api/prompts') {
      this.sendJson(res, 200, Array.from(this.prompts.values()).sort((a, b) => b.createdAt - a.createdAt));
      return;
    }

    if (url.pathname.startsWith('/api/instances/') && url.pathname.endsWith('/messages')) {
      const instanceId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const bundle = await this.buildBundle(instanceId);
      this.sendJson(res, 200, bundle ? bundle.messages.slice(-200) : []);
      return;
    }

    if (url.pathname.startsWith('/api/instances/') && url.pathname.endsWith('/replay')) {
      const instanceId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const bundle = await this.buildBundle(instanceId);
      if (!bundle) {
        this.sendJson(res, 404, { error: 'Instance not found' });
        return;
      }
      this.sendJson(res, 200, bundle);
      return;
    }

    if (url.pathname === '/api/events') {
      this.handleSse(req, res);
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }

  private async buildBundle(instanceId: string) {
    const instance = this.deps?.instanceManager.getInstance(instanceId);
    if (!instance) {
      return null;
    }
    return getSessionShareService().createBundle({ instance });
  }

  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    const authHeader = req.headers['authorization'];
    const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;
    const queryToken = url.searchParams.get('token') || undefined;
    return getRemoteObserverAuth().validate(bearer || queryToken);
  }

  private handleSse(_req: IncomingMessage, res: ServerResponse): void {
    const client = res as SseClient;
    client.__observerId = randomUUID();
    client.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    client.write(`event: snapshot\ndata: ${JSON.stringify(this.buildSnapshot())}\n\n`);
    this.clients.add(client);
    client.on('close', () => {
      this.clients.delete(client);
    });
  }

  private broadcast(type: RemoteObserverEventEnvelope['type'], data: unknown): void {
    this.state.lastEventAt = Date.now();
    if (!this.server || this.clients.size === 0) {
      return;
    }

    const payload: RemoteObserverEventEnvelope = {
      id: randomUUID(),
      type,
      timestamp: this.state.lastEventAt,
      data: data as RemoteObserverEventEnvelope['data'],
    };

    const raw = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      client.write(raw);
    }
  }

  private sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
  }

  private sendObserverPage(res: ServerResponse): void {
    const response = buildObserverPageResponse();
    res.writeHead(200, response.headers);
    res.end(response.html);
  }

  private sendStaticAsset(res: ServerResponse, contentType: string, body: string): void {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }
}

function sanitizeWorkingDirectory(workingDirectory: string): string {
  if (!workingDirectory) {
    return '<workspace>';
  }
  const basename = crossPlatformBasename(workingDirectory);
  return basename ? path.posix.join('<workspace>', basename) : '<workspace>';
}

function sanitizeMessagePayload(
  message: { id?: string; type: string; content: string; timestamp: number },
  workingDirectory?: string,
): { id?: string; type: string; content: string; timestamp: number } {
  const safeWorkingDirectory = workingDirectory ? path.resolve(workingDirectory) : '';
  const content = safeWorkingDirectory
    ? message.content.split(safeWorkingDirectory).join('<workspace>')
    : message.content;
  return {
    ...message,
    content,
  };
}

export function getRemoteObserverServer(): RemoteObserverServer {
  return RemoteObserverServer.getInstance();
}
