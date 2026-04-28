import * as crypto from 'crypto';
import * as http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from '../persistence/rlm/rlm-schema';
import { WebhookServer } from './webhook-server';
import { WebhookStore } from './webhook-store';

const mocks = vi.hoisted(() => ({
  fire: vi.fn(),
}));

vi.mock('../automations', () => ({
  getAutomationRunner: () => ({
    fire: mocks.fire,
  }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.pragma('foreign_keys = ON');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

function sign(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function post(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body).toString(),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve({
          statusCode: res.statusCode ?? 0,
          json: text ? JSON.parse(text) as Record<string, unknown> : {},
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('WebhookServer', () => {
  let db: SqliteDriver;
  let store: WebhookStore;
  let server: WebhookServer;
  let port: number;

  beforeEach(async () => {
    mocks.fire.mockReset();
    db = createDb();
    store = new WebhookStore(db);
    server = new WebhookServer(store);
    port = await server.start(0);
  });

  afterEach(() => {
    server.stop();
    db.close();
  });

  it('verifies HMAC with the route secret and deduplicates deliveries', async () => {
    const secret = 'test-secret-123456';
    const route = store.createRoute({
      path: '/hooks/build',
      secret,
      allowedAutomationIds: ['automation-1'],
      allowedEvents: ['build.finished'],
    });
    expect(route.secretHash).toBe(crypto.createHash('sha256').update(secret).digest('hex'));
    expect(route.secretHash).not.toBe(secret);

    const body = JSON.stringify({ id: 'delivery-1', event: 'build.finished' });
    const first = await post(port, '/hooks/build', body, {
      'x-orchestrator-signature': sign(secret, body),
    });
    const second = await post(port, '/hooks/build', body, {
      'x-orchestrator-signature': sign(secret, body),
    });

    expect(first.statusCode).toBe(202);
    expect(first.json).toMatchObject({ accepted: true, deliveryId: 'delivery-1' });
    expect(second.statusCode).toBe(202);
    expect(second.json).toMatchObject({ duplicate: true });
    expect(mocks.fire).toHaveBeenCalledTimes(1);
    expect(mocks.fire).toHaveBeenCalledWith('automation-1', expect.objectContaining({
      trigger: 'webhook',
      idempotencyKey: 'delivery-1',
      deliveryMode: 'notify',
    }));
  });

  it('rejects invalid signatures and invalid JSON without firing automations', async () => {
    const secret = 'test-secret-123456';
    store.createRoute({ path: '/hooks/reject', secret, allowedAutomationIds: ['automation-1'] });

    const invalidSignature = await post(port, '/hooks/reject', '{"ok":true}', {
      'x-orchestrator-signature': 'sha256=bad',
    });
    const invalidJsonBody = '{not-json';
    const invalidJson = await post(port, '/hooks/reject', invalidJsonBody, {
      'x-orchestrator-signature': sign(secret, invalidJsonBody),
    });

    expect(invalidSignature.statusCode).toBe(401);
    expect(invalidJson.statusCode).toBe(400);
    expect(mocks.fire).not.toHaveBeenCalled();
  });

  it('returns 413 for oversized bodies before parsing', async () => {
    store.createRoute({
      path: '/hooks/large',
      secret: 'test-secret-123456',
      allowUnsignedDev: true,
      maxBodyBytes: 8,
    });

    const response = await post(port, '/hooks/large', JSON.stringify({ large: true }));

    expect(response.statusCode).toBe(413);
    expect(response.json.error).toContain('exceeds');
  });

  it('rate-limits by route and remote address', async () => {
    const limited = new WebhookServer(store, {
      maxRequestsPerWindow: 1,
      rateLimitWindowMs: 60_000,
    });
    server.stop();
    server = limited;
    port = await server.start(0);
    store.createRoute({
      path: '/hooks/limited',
      secret: 'test-secret-123456',
      allowUnsignedDev: true,
    });

    const first = await post(port, '/hooks/limited', JSON.stringify({ id: 'a' }));
    const second = await post(port, '/hooks/limited', JSON.stringify({ id: 'b' }));

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
  });
});
