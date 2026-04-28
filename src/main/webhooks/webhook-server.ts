import * as crypto from 'crypto';
import * as http from 'http';
import { URL } from 'url';
import { getLogger } from '../logging/logger';
import { getAutomationRunner } from '../automations';
import { getWebhookStore, WebhookStore } from './webhook-store';
import type { WebhookRouteConfig, WebhookServerOptions, WebhookServerStatus } from './webhook-types';

const logger = getLogger('WebhookServer');

interface WebhookPayload {
  id?: string;
  event?: string;
  type?: string;
  [key: string]: unknown;
}

export class WebhookServer {
  private static instance: WebhookServer | null = null;
  private server: http.Server | null = null;
  private port: number | undefined;

  constructor(
    private readonly store: WebhookStore = getWebhookStore(),
    private readonly options: WebhookServerOptions = {},
  ) {}

  static getInstance(): WebhookServer {
    if (!this.instance) {
      this.instance = new WebhookServer();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.stop();
    this.instance = null;
  }

  start(port = this.options.port ?? 0): Promise<number> {
    if (this.server) {
      return Promise.resolve(this.port ?? port);
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        logger.warn('Webhook request failed', { error: error instanceof Error ? error.message : String(error) });
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'webhook request failed' }));
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => {
        const address = this.server!.address();
        this.port = typeof address === 'object' && address ? address.port : port;
        resolve(this.port);
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.port = undefined;
  }

  getStatus(): WebhookServerStatus {
    return {
      running: this.server !== null,
      port: this.port,
      routeCount: this.store.listRoutes().length,
      recentDeliveries: this.store.recentDeliveries(20),
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.send(res, 405, { error: 'method not allowed' });
      return;
    }

    const requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const route = this.store.getRouteByPath(requestPath);
    if (!route || !route.enabled) {
      this.send(res, 404, { error: 'webhook route not found' });
      return;
    }

    const body = await this.readBody(req, route.maxBodyBytes);
    const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
    if (!this.verifySignature(route, body, req.headers['x-orchestrator-signature'])) {
      const deliveryId = this.deliveryId(req, undefined, payloadHash);
      this.store.recordDelivery(route.id, deliveryId, undefined, 'rejected', payloadHash, {
        statusCode: 401,
        error: 'invalid signature',
      });
      this.send(res, 401, { error: 'invalid signature' });
      return;
    }

    const payload = JSON.parse(body.toString('utf-8')) as WebhookPayload;
    const eventType = typeof payload.event === 'string'
      ? payload.event
      : typeof payload.type === 'string'
        ? payload.type
        : undefined;
    if (route.allowedEvents.length > 0 && (!eventType || !route.allowedEvents.includes(eventType))) {
      const deliveryId = this.deliveryId(req, payload, payloadHash);
      this.store.recordDelivery(route.id, deliveryId, eventType, 'rejected', payloadHash, {
        statusCode: 202,
        error: 'event not allowed for route',
      });
      this.send(res, 202, { ignored: true });
      return;
    }

    const deliveryId = this.deliveryId(req, payload, payloadHash);
    const existing = this.store.findDelivery(route.id, deliveryId);
    if (existing) {
      this.store.recordDelivery(route.id, `${deliveryId}:duplicate`, eventType, 'duplicate', payloadHash, {
        statusCode: 202,
      });
      this.send(res, 202, { duplicate: true });
      return;
    }

    const source = {
      type: 'webhook' as const,
      id: route.id,
      eventType,
      deliveryId,
      metadata: {
        path: route.path,
        payloadHash,
      },
    };
    this.store.recordDelivery(route.id, deliveryId, eventType, 'accepted', payloadHash, {
      statusCode: 202,
      triggerSource: source,
    });

    for (const automationId of route.allowedAutomationIds) {
      await getAutomationRunner().fire(automationId, {
        trigger: 'webhook',
        scheduledAt: Date.now(),
        idempotencyKey: deliveryId,
        triggerSource: source,
        deliveryMode: 'notify',
      });
    }

    this.send(res, 202, { accepted: true, deliveryId });
  }

  private readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          reject(new Error(`request body exceeds ${maxBytes} bytes`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private verifySignature(route: WebhookRouteConfig, body: Buffer, header: string | string[] | undefined): boolean {
    if ((route.allowUnsignedDev || this.options.allowUnsignedDev) && !header) {
      return true;
    }
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) {
      return false;
    }
    const expected = crypto.createHmac('sha256', route.secretHash).update(body).digest('hex');
    const normalized = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
    return normalized.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(normalized), Buffer.from(expected));
  }

  private deliveryId(req: http.IncomingMessage, payload: WebhookPayload | undefined, payloadHash: string): string {
    const header = req.headers['x-orchestrator-delivery'];
    if (typeof header === 'string' && header.trim()) {
      return header.trim();
    }
    if (payload && typeof payload.id === 'string' && payload.id.trim()) {
      return payload.id.trim();
    }
    return payloadHash;
  }

  private send(res: http.ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    res.writeHead(statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

export function getWebhookServer(): WebhookServer {
  return WebhookServer.getInstance();
}
