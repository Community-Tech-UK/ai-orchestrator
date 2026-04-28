import * as crypto from 'crypto';
import * as http from 'http';
import { URL } from 'url';
import { getLogger } from '../logging/logger';
import { getAutomationRunner } from '../automations';
import { getWebhookStore, WebhookStore } from './webhook-store';
import { RateLimiter } from '../channels/rate-limiter';
import type { WebhookRuntimeRouteConfig, WebhookServerOptions, WebhookServerStatus } from './webhook-types';

const logger = getLogger('WebhookServer');
const DEFAULT_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface WebhookPayload {
  id?: string;
  event?: string;
  type?: string;
  [key: string]: unknown;
}

class WebhookHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class WebhookServer {
  private static instance: WebhookServer | null = null;
  private server: http.Server | null = null;
  private port: number | undefined;
  private readonly rateLimiter: RateLimiter;

  constructor(
    private readonly store: WebhookStore = getWebhookStore(),
    private readonly options: WebhookServerOptions = {},
  ) {
    this.rateLimiter = new RateLimiter(
      options.maxRequestsPerWindow ?? 60,
      options.rateLimitWindowMs ?? 60_000,
    );
  }

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
        if (!res.headersSent) {
          const statusCode = error instanceof WebhookHttpError ? error.statusCode : 500;
          res.writeHead(statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'webhook request failed' }));
        }
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
    const route = this.store.getRuntimeRouteByPath(requestPath);
    if (!route || !route.enabled) {
      this.send(res, 404, { error: 'webhook route not found' });
      return;
    }

    const rateLimitKey = `${route.id}:${req.socket.remoteAddress ?? 'unknown'}`;
    if (!this.rateLimiter.check(rateLimitKey)) {
      const deliveryId = this.deliveryId(req, undefined, 'rate-limited');
      this.store.recordDelivery(route.id, deliveryId, undefined, 'rejected', 'rate-limited', {
        statusCode: 429,
        error: 'rate limit exceeded',
      });
      this.send(res, 429, { error: 'rate limit exceeded' });
      return;
    }

    const contentLength = typeof req.headers['content-length'] === 'string'
      ? Number.parseInt(req.headers['content-length'], 10)
      : undefined;
    if (contentLength !== undefined && contentLength > route.maxBodyBytes) {
      const deliveryId = this.deliveryId(req, undefined, 'body-too-large');
      this.store.recordDelivery(route.id, deliveryId, undefined, 'rejected', 'body-too-large', {
        statusCode: 413,
        error: `request body exceeds ${route.maxBodyBytes} bytes`,
      });
      this.send(res, 413, { error: `request body exceeds ${route.maxBodyBytes} bytes` });
      return;
    }

    let body: Buffer;
    try {
      body = await this.readBody(req, route.maxBodyBytes);
    } catch (error) {
      if (error instanceof WebhookHttpError) {
        const deliveryId = this.deliveryId(req, undefined, 'body-too-large');
        this.store.recordDelivery(route.id, deliveryId, undefined, 'rejected', 'body-too-large', {
          statusCode: error.statusCode,
          error: error.message,
        });
        this.send(res, error.statusCode, { error: error.message });
        return;
      }
      throw error;
    }

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

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(body.toString('utf-8')) as WebhookPayload;
    } catch {
      const deliveryId = this.deliveryId(req, undefined, payloadHash);
      this.store.recordDelivery(route.id, deliveryId, undefined, 'rejected', payloadHash, {
        statusCode: 400,
        error: 'invalid json',
      });
      this.send(res, 400, { error: 'invalid json' });
      return;
    }

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
    const deliveryTtlMs = this.options.deliveryTtlMs ?? DEFAULT_DELIVERY_TTL_MS;
    if (deliveryTtlMs > 0) {
      this.store.pruneDeliveriesOlderThan(Date.now() - deliveryTtlMs);
    }
    const existing = deliveryTtlMs > 0
      ? this.store.findRecentDelivery(route.id, deliveryId, deliveryTtlMs)
      : this.store.findDelivery(route.id, deliveryId);
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
      let settled = false;
      req.on('data', (chunk: Buffer) => {
        if (settled) {
          return;
        }
        bytes += chunk.length;
        if (bytes > maxBytes) {
          settled = true;
          reject(new WebhookHttpError(413, `request body exceeds ${maxBytes} bytes`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!settled) {
          settled = true;
          resolve(Buffer.concat(chunks));
        }
      });
      req.on('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  }

  private verifySignature(route: WebhookRuntimeRouteConfig, body: Buffer, header: string | string[] | undefined): boolean {
    if ((route.allowUnsignedDev || this.options.allowUnsignedDev) && !header) {
      return true;
    }
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) {
      return false;
    }
    const expected = crypto.createHmac('sha256', route.signingSecret).update(body).digest('hex');
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
