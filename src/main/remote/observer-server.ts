import * as os from 'os';
import * as path from 'path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { URL } from 'url';
import type { InstanceManager } from '../instance/instance-manager';
import { getLogger } from '../logging/logger';
import { getRepoJobService } from '../repo-jobs';
import { getSessionShareService } from '../session/session-share-service';
import { getRemoteObserverAuth } from './observer-auth';
import { getWorkerNodeRegistry } from '../remote-node';
import type {
  RemoteObserverEventEnvelope,
  RemoteObserverInstanceSummary,
  RemoteObserverPrompt,
  RemoteObserverSnapshot,
  RemoteObserverStatus,
} from '../../shared/types/remote-observer.types';

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
      this.sendHtml(res, renderObserverHtml());
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
      'Access-Control-Allow-Origin': '*',
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
    });
    res.end(JSON.stringify(payload));
  }

  private sendHtml(res: ServerResponse, html: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  }
}

function getLocalIpv4Addresses(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];

  for (const values of Object.values(interfaces)) {
    for (const iface of values || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }

  return ips;
}

function sanitizeWorkingDirectory(workingDirectory: string): string {
  if (!workingDirectory) {
    return '<workspace>';
  }
  const basename = path.basename(workingDirectory);
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

function renderObserverHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Orchestrator Observer</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #09111a;
        --panel: rgba(14, 24, 36, 0.92);
        --panel-alt: rgba(20, 32, 46, 0.9);
        --border: rgba(148, 163, 184, 0.18);
        --text: #e6edf5;
        --muted: #9cb0c3;
        --accent: #4ade80;
        --warning: #fbbf24;
        --error: #f87171;
        --info: #38bdf8;
        --shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top right, rgba(56, 189, 248, 0.15), transparent 32rem),
          radial-gradient(circle at bottom left, rgba(74, 222, 128, 0.12), transparent 28rem),
          var(--bg);
      }

      header {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        gap: 1rem;
        padding: 1.5rem;
      }

      h1, h2, h3, p { margin: 0; }
      h1 { font-size: clamp(2rem, 4vw, 2.8rem); line-height: 0.95; }
      h2 { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
      p, li, button, input, select { font: inherit; }

      .subtitle {
        margin-top: 0.5rem;
        color: var(--muted);
        max-width: 40rem;
      }

      .toolbar, .stats, .grid, .panel-list, .detail-list, .message-list {
        display: grid;
        gap: 1rem;
      }

      .toolbar, .stats, .grid {
        padding: 0 1.5rem 1.5rem;
      }

      .toolbar {
        grid-template-columns: minmax(0, 1fr) auto auto;
        align-items: end;
      }

      .toolbar label {
        display: grid;
        gap: 0.35rem;
        color: var(--muted);
        font-size: 0.82rem;
      }

      .toolbar input, .toolbar select {
        width: 100%;
        padding: 0.8rem 0.95rem;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(8, 15, 24, 0.9);
        color: var(--text);
      }

      .stats {
        grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
      }

      .stat, .panel {
        border: 1px solid var(--border);
        background: var(--panel);
        border-radius: 1rem;
        box-shadow: var(--shadow);
      }

      .stat {
        padding: 1rem 1.1rem;
      }

      .stat strong {
        display: block;
        margin-top: 0.35rem;
        font-size: 1.5rem;
      }

      .grid {
        grid-template-columns: minmax(18rem, 24rem) minmax(18rem, 24rem) minmax(0, 1fr);
        align-items: start;
      }

      .panel {
        padding: 1rem;
      }

      .panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        padding-bottom: 0.75rem;
        border-bottom: 1px solid var(--border);
        margin-bottom: 0.9rem;
      }

      .panel-list, .detail-list, .message-list {
        max-height: 62vh;
        overflow: auto;
      }

      .card, .detail-card, .message {
        border: 1px solid var(--border);
        border-radius: 0.9rem;
        padding: 0.85rem;
        background: var(--panel-alt);
      }

      .card button, .toolbar button {
        border: 0;
        border-radius: 999px;
        padding: 0.72rem 1rem;
        font-weight: 600;
        cursor: pointer;
      }

      .toolbar button, .card button {
        background: rgba(56, 189, 248, 0.18);
        color: var(--text);
      }

      .toolbar button.primary {
        background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
        color: #07111a;
      }

      .toolbar button.secondary {
        background: rgba(148, 163, 184, 0.16);
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        border-radius: 999px;
        padding: 0.3rem 0.6rem;
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        background: rgba(148, 163, 184, 0.14);
        color: var(--muted);
      }

      .pill.running { color: var(--accent); background: rgba(74, 222, 128, 0.14); }
      .pill.failed, .pill.error { color: var(--error); background: rgba(248, 113, 113, 0.14); }
      .pill.waiting_for_input { color: var(--warning); background: rgba(251, 191, 36, 0.14); }
      .pill.busy, .pill.running-job { color: var(--info); background: rgba(56, 189, 248, 0.14); }

      .row {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: center;
      }

      .meta, .empty {
        color: var(--muted);
        font-size: 0.85rem;
      }

      .message pre {
        margin: 0.5rem 0 0;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .detail-card h3, .card h3 {
        font-size: 0.95rem;
        margin-bottom: 0.25rem;
      }

      .urls {
        display: grid;
        gap: 0.5rem;
      }

      .urls a {
        color: #c7f9d6;
        text-decoration: none;
        word-break: break-all;
      }

      .urls a:hover {
        text-decoration: underline;
      }

      @media (max-width: 1080px) {
        .grid { grid-template-columns: 1fr; }
        .toolbar { grid-template-columns: 1fr; }
        .detail-list, .panel-list, .message-list { max-height: none; }
      }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h2>Read-only Observer</h2>
        <h1>Local Orchestrator</h1>
        <p class="subtitle">Observe local instances, repo jobs, and prompts without write access. This page auto-refreshes through the observer event stream.</p>
      </div>
      <div class="urls" id="observer-urls"></div>
    </header>

    <section class="toolbar">
      <label>
        Selected Instance
        <select id="instance-select"></select>
      </label>
      <button class="secondary" id="refresh-btn" type="button">Refresh Snapshot</button>
      <button class="primary" id="open-replay-btn" type="button">Open Replay JSON</button>
    </section>

    <section class="stats" id="stats"></section>

    <section class="grid">
      <article class="panel">
        <div class="panel-header">
          <h3>Instances</h3>
          <span class="meta" id="instance-count">0</span>
        </div>
        <div class="panel-list" id="instance-list"></div>
      </article>

      <article class="panel">
        <div class="panel-header">
          <h3>Repo Jobs</h3>
          <span class="meta" id="job-count">0</span>
        </div>
        <div class="panel-list" id="job-list"></div>
      </article>

      <article class="panel">
        <div class="panel-header">
          <h3>Live Detail</h3>
          <span class="meta" id="detail-title">Select an instance</span>
        </div>
        <div class="detail-list" id="detail-list"></div>
        <div class="message-list" id="message-list"></div>
      </article>
    </section>

    <script>
      const token = new URLSearchParams(window.location.search).get('token') || '';
      const authSuffix = token ? '?token=' + encodeURIComponent(token) : '';
      const state = {
        snapshot: null,
        selectedInstanceId: '',
        messageCache: new Map(),
      };

      const els = {
        stats: document.getElementById('stats'),
        instanceList: document.getElementById('instance-list'),
        jobList: document.getElementById('job-list'),
        detailList: document.getElementById('detail-list'),
        messageList: document.getElementById('message-list'),
        detailTitle: document.getElementById('detail-title'),
        instanceCount: document.getElementById('instance-count'),
        jobCount: document.getElementById('job-count'),
        instanceSelect: document.getElementById('instance-select'),
        refreshBtn: document.getElementById('refresh-btn'),
        openReplayBtn: document.getElementById('open-replay-btn'),
        observerUrls: document.getElementById('observer-urls'),
      };

      function formatDate(value) {
        if (!value) return 'n/a';
        try { return new Date(value).toLocaleString(); } catch { return String(value); }
      }

      function pill(label, className = '') {
        return '<span class="pill ' + className + '">' + label + '</span>';
      }

      function renderStats(snapshot) {
        const status = snapshot.status;
        els.stats.innerHTML = [
          ['Mode', status.mode],
          ['Instances', String(status.instanceCount)],
          ['Jobs', String(status.jobCount)],
          ['Prompts', String(status.pendingPromptCount)],
          ['Last Event', formatDate(status.lastEventAt)],
        ].map(([label, value]) =>
          '<article class="stat"><span class="meta">' + label + '</span><strong>' + value + '</strong></article>'
        ).join('');

        els.observerUrls.innerHTML = (status.observerUrls || [])
          .map((url) => '<a href="' + url + '" target="_blank" rel="noreferrer">' + url + '</a>')
          .join('');
      }

      function renderInstances(snapshot) {
        const instances = snapshot.instances || [];
        els.instanceCount.textContent = String(instances.length);
        els.instanceSelect.innerHTML = '<option value="">Select instance</option>' + instances.map((instance) =>
          '<option value="' + instance.id + '"' + (instance.id === state.selectedInstanceId ? ' selected' : '') + '>' +
            instance.displayName + ' (' + instance.status + ')' +
          '</option>'
        ).join('');

        els.instanceList.innerHTML = instances.length === 0
          ? '<p class="empty">No instances are running.</p>'
          : instances.map((instance) =>
              '<div class="card">' +
                '<div class="row"><h3>' + instance.displayName + '</h3>' + pill(instance.status, instance.status) + '</div>' +
                '<p class="meta">' + (instance.provider || 'provider n/a') + ' · ' + (instance.model || 'model n/a') + '</p>' +
                '<p class="meta">' + instance.workingDirectoryLabel + '</p>' +
                '<p class="meta">Last activity ' + formatDate(instance.lastActivity) + '</p>' +
                '<button type="button" data-instance-id="' + instance.id + '">Inspect</button>' +
              '</div>'
            ).join('');
      }

      function renderJobs(snapshot) {
        const jobs = snapshot.jobs || [];
        els.jobCount.textContent = String(jobs.length);
        els.jobList.innerHTML = jobs.length === 0
          ? '<p class="empty">No repo jobs have been recorded.</p>'
          : jobs.map((job) =>
              '<div class="card">' +
                '<div class="row"><h3>' + job.name + '</h3>' + pill(job.status, job.status === 'running' ? 'running-job' : job.status) + '</div>' +
                '<p class="meta">' + job.type + ' · ' + job.workingDirectory + '</p>' +
                '<p class="meta">' + (job.progressMessage || 'Progress ' + job.progress + '%') + '</p>' +
                (job.result && job.result.summary ? '<pre>' + escapeHtml(job.result.summary) + '</pre>' : '') +
              '</div>'
            ).join('');
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      async function loadMessages(instanceId) {
        if (!instanceId) {
          els.detailTitle.textContent = 'Select an instance';
          els.detailList.innerHTML = '';
          els.messageList.innerHTML = '<p class="empty">Messages will appear here.</p>';
          return;
        }

        const response = await fetch('/api/instances/' + encodeURIComponent(instanceId) + '/messages' + authSuffix);
        if (!response.ok) {
          els.messageList.innerHTML = '<p class="empty">Failed to load messages.</p>';
          return;
        }
        const messages = await response.json();
        state.messageCache.set(instanceId, messages);
        renderDetails(instanceId);
      }

      function renderDetails(instanceId) {
        const snapshot = state.snapshot;
        if (!snapshot || !instanceId) {
          return;
        }

        const instance = (snapshot.instances || []).find((item) => item.id === instanceId);
        els.detailTitle.textContent = instance ? instance.displayName : instanceId;
        els.detailList.innerHTML = instance
          ? [
              '<div class="detail-card"><h3>Status</h3><p class="meta">' + instance.status + '</p></div>',
              '<div class="detail-card"><h3>Provider</h3><p class="meta">' + (instance.provider || 'n/a') + '</p></div>',
              '<div class="detail-card"><h3>Model</h3><p class="meta">' + (instance.model || 'n/a') + '</p></div>',
              '<div class="detail-card"><h3>Workspace</h3><p class="meta">' + instance.workingDirectoryLabel + '</p></div>',
            ].join('')
          : '<p class="empty">Instance not found.</p>';

        const prompts = (snapshot.pendingPrompts || []).filter((prompt) => prompt.instanceId === instanceId);
        const promptCards = prompts.map((prompt) =>
          '<div class="detail-card">' +
            '<div class="row"><h3>' + prompt.title + '</h3>' + pill(prompt.promptType, prompt.promptType === 'input-required' ? 'waiting_for_input' : '') + '</div>' +
            '<p class="meta">' + escapeHtml(prompt.message) + '</p>' +
          '</div>'
        );
        const messages = state.messageCache.get(instanceId) || [];
        els.messageList.innerHTML = promptCards.join('') + (messages.length === 0
          ? '<p class="empty">No messages loaded for this instance.</p>'
          : messages.slice(-120).map((message) =>
              '<article class="message">' +
                '<div class="row"><span>' + escapeHtml(message.type) + '</span><span class="meta">' + formatDate(message.timestamp) + '</span></div>' +
                '<pre>' + escapeHtml(message.content || '') + '</pre>' +
              '</article>'
            ).join(''));
      }

      async function loadSnapshot() {
        const response = await fetch('/api/snapshot' + authSuffix);
        if (!response.ok) {
          document.body.innerHTML = '<main style="padding:2rem;color:#fecaca;font-family:ui-sans-serif,system-ui">Observer authentication failed or the server is unavailable.</main>';
          return;
        }

        state.snapshot = await response.json();
        if (!state.selectedInstanceId && state.snapshot.instances && state.snapshot.instances[0]) {
          state.selectedInstanceId = state.snapshot.instances[0].id;
        }
        render();
        await loadMessages(state.selectedInstanceId);
      }

      function render() {
        if (!state.snapshot) return;
        renderStats(state.snapshot);
        renderInstances(state.snapshot);
        renderJobs(state.snapshot);
        renderDetails(state.selectedInstanceId);
      }

      function connectEvents() {
        const source = new EventSource('/api/events' + authSuffix);
        source.onmessage = () => {};
        ['status', 'repo-job', 'instance-state', 'instance-output', 'permission-prompt'].forEach((type) => {
          source.addEventListener(type, async () => {
            await loadSnapshot();
          });
        });
        source.addEventListener('error', () => {
          window.setTimeout(connectEvents, 2000);
          source.close();
        });
      }

      els.instanceSelect.addEventListener('change', async (event) => {
        state.selectedInstanceId = event.target.value;
        renderDetails(state.selectedInstanceId);
        await loadMessages(state.selectedInstanceId);
      });

      els.refreshBtn.addEventListener('click', async () => {
        await loadSnapshot();
      });

      els.openReplayBtn.addEventListener('click', () => {
        if (!state.selectedInstanceId) return;
        window.open('/api/instances/' + encodeURIComponent(state.selectedInstanceId) + '/replay' + authSuffix, '_blank', 'noopener');
      });

      document.addEventListener('click', async (event) => {
        const target = event.target.closest('[data-instance-id]');
        if (!target) return;
        state.selectedInstanceId = target.getAttribute('data-instance-id') || '';
        els.instanceSelect.value = state.selectedInstanceId;
        await loadMessages(state.selectedInstanceId);
      });

      loadSnapshot().then(connectEvents);
    </script>
  </body>
</html>`;
}
