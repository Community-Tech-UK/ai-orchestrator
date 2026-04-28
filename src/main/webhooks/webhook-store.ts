import * as crypto from 'crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import { generateId } from '../../shared/utils/id-generator';
import type { WebhookCreateRouteInput, WebhookDeliveryRecord, WebhookRouteConfig } from './webhook-types';

interface WebhookRouteRow {
  id: string;
  path: string;
  secret_hash: string;
  enabled: number;
  allow_unsigned_dev: number;
  max_body_bytes: number;
  allowed_automation_ids_json: string;
  allowed_events_json: string;
  created_at: number;
  updated_at: number;
}

interface WebhookDeliveryRow {
  id: string;
  route_id: string;
  delivery_id: string;
  event_type: string | null;
  status: WebhookDeliveryRecord['status'];
  status_code: number | null;
  error: string | null;
  payload_hash: string;
  received_at: number;
  processed_at: number | null;
  trigger_source_json: string | null;
}

export class WebhookStore {
  constructor(private readonly db: SqliteDriver = getRLMDatabase().getRawDb()) {}

  hashSecret(secret: string): string {
    return crypto.createHash('sha256').update(secret).digest('hex');
  }

  createRoute(input: WebhookCreateRouteInput, now = Date.now()): WebhookRouteConfig {
    const id = generateId();
    this.db.prepare(`
      INSERT INTO webhook_routes
        (id, path, secret_hash, enabled, allow_unsigned_dev, max_body_bytes,
         allowed_automation_ids_json, allowed_events_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      this.normalizePath(input.path),
      this.hashSecret(input.secret),
      input.enabled === false ? 0 : 1,
      input.allowUnsignedDev === true ? 1 : 0,
      input.maxBodyBytes ?? 262_144,
      JSON.stringify(input.allowedAutomationIds ?? []),
      JSON.stringify(input.allowedEvents ?? []),
      now,
      now,
    );
    return this.getRoute(id)!;
  }

  listRoutes(): WebhookRouteConfig[] {
    return this.db.prepare(`
      SELECT *
      FROM webhook_routes
      ORDER BY created_at DESC
    `).all<WebhookRouteRow>().map((row) => this.mapRoute(row));
  }

  getRoute(id: string): WebhookRouteConfig | null {
    const row = this.db.prepare(`SELECT * FROM webhook_routes WHERE id = ?`).get<WebhookRouteRow>(id);
    return row ? this.mapRoute(row) : null;
  }

  getRouteByPath(requestPath: string): WebhookRouteConfig | null {
    const row = this.db.prepare(`SELECT * FROM webhook_routes WHERE path = ?`).get<WebhookRouteRow>(this.normalizePath(requestPath));
    return row ? this.mapRoute(row) : null;
  }

  recordDelivery(
    routeId: string,
    deliveryId: string,
    eventType: string | undefined,
    status: WebhookDeliveryRecord['status'],
    payloadHash: string,
    options: {
      statusCode?: number;
      error?: string;
      triggerSource?: Record<string, unknown>;
      now?: number;
    } = {},
  ): WebhookDeliveryRecord {
    const existing = this.findDelivery(routeId, deliveryId);
    if (existing) {
      return existing;
    }
    const now = options.now ?? Date.now();
    const id = generateId();
    this.db.prepare(`
      INSERT INTO webhook_deliveries
        (id, route_id, delivery_id, event_type, status, status_code, error,
         payload_hash, received_at, processed_at, trigger_source_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      routeId,
      deliveryId,
      eventType ?? null,
      status,
      options.statusCode ?? null,
      options.error ?? null,
      payloadHash,
      now,
      status === 'accepted' ? now : null,
      options.triggerSource ? JSON.stringify(options.triggerSource) : null,
    );
    return this.findDelivery(routeId, deliveryId)!;
  }

  findDelivery(routeId: string, deliveryId: string): WebhookDeliveryRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM webhook_deliveries
      WHERE route_id = ? AND delivery_id = ?
    `).get<WebhookDeliveryRow>(routeId, deliveryId);
    return row ? this.mapDelivery(row) : null;
  }

  recentDeliveries(limit = 50): WebhookDeliveryRecord[] {
    return this.db.prepare(`
      SELECT *
      FROM webhook_deliveries
      ORDER BY received_at DESC
      LIMIT ?
    `).all<WebhookDeliveryRow>(limit).map((row) => this.mapDelivery(row));
  }

  private normalizePath(requestPath: string): string {
    return requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  }

  private mapRoute(row: WebhookRouteRow): WebhookRouteConfig {
    return {
      id: row.id,
      path: row.path,
      secretHash: row.secret_hash,
      enabled: row.enabled === 1,
      allowUnsignedDev: row.allow_unsigned_dev === 1,
      maxBodyBytes: row.max_body_bytes,
      allowedAutomationIds: JSON.parse(row.allowed_automation_ids_json) as string[],
      allowedEvents: JSON.parse(row.allowed_events_json) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapDelivery(row: WebhookDeliveryRow): WebhookDeliveryRecord {
    return {
      id: row.id,
      routeId: row.route_id,
      deliveryId: row.delivery_id,
      eventType: row.event_type ?? undefined,
      status: row.status,
      statusCode: row.status_code ?? undefined,
      error: row.error ?? undefined,
      payloadHash: row.payload_hash,
      receivedAt: row.received_at,
      processedAt: row.processed_at ?? undefined,
      triggerSource: row.trigger_source_json
        ? JSON.parse(row.trigger_source_json) as Record<string, unknown>
        : undefined,
    };
  }
}

let webhookStore: WebhookStore | null = null;

export function getWebhookStore(): WebhookStore {
  if (!webhookStore) {
    webhookStore = new WebhookStore();
  }
  return webhookStore;
}

export function _resetWebhookStoreForTesting(): void {
  webhookStore = null;
}
