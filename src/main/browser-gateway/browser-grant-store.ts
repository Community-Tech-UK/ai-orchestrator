import type { BrowserPermissionGrant } from '@contracts/types/browser';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import { generateId } from '../../shared/utils/id-generator';

interface BrowserGrantRow {
  id: string;
  mode: BrowserPermissionGrant['mode'];
  instance_id: string;
  provider: BrowserPermissionGrant['provider'];
  profile_id: string | null;
  target_id: string | null;
  allowed_origins_json: string;
  allowed_action_classes_json: string;
  allow_external_navigation: number;
  upload_roots_json: string | null;
  autonomous: number;
  requested_by: string;
  decided_by: BrowserPermissionGrant['decidedBy'];
  decision: BrowserPermissionGrant['decision'];
  reason: string | null;
  expires_at: number;
  created_at: number;
  revoked_at: number | null;
  consumed_at: number | null;
}

export type BrowserGrantInput = Omit<
  BrowserPermissionGrant,
  'id' | 'createdAt' | 'revokedAt' | 'consumedAt'
>;

export interface BrowserGrantListFilter {
  instanceId?: string;
  profileId?: string;
  includeExpired?: boolean;
  limit?: number;
}

export class BrowserGrantStore {
  constructor(private readonly db: SqliteDriver = getRLMDatabase().getRawDb()) {}

  createGrant(input: BrowserGrantInput): BrowserPermissionGrant {
    const id = generateId();
    const now = Date.now();
    this.db
      .prepare(
        `
        INSERT INTO browser_permission_grants
          (id, mode, instance_id, provider, profile_id, target_id,
           allowed_origins_json, allowed_action_classes_json,
           allow_external_navigation, upload_roots_json, autonomous,
           requested_by, decided_by, decision, reason, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.mode,
        input.instanceId,
        input.provider,
        input.profileId ?? null,
        input.targetId ?? null,
        JSON.stringify(input.allowedOrigins),
        JSON.stringify(input.allowedActionClasses),
        input.allowExternalNavigation ? 1 : 0,
        input.uploadRoots ? JSON.stringify(input.uploadRoots) : null,
        input.autonomous ? 1 : 0,
        input.requestedBy,
        input.decidedBy,
        input.decision,
        input.reason ?? null,
        input.expiresAt,
        now,
      );

    return this.getGrant(id)!;
  }

  getGrant(grantId: string): BrowserPermissionGrant | null {
    const row = this.db
      .prepare(`SELECT * FROM browser_permission_grants WHERE id = ?`)
      .get<BrowserGrantRow>(grantId);
    return row ? this.map(row) : null;
  }

  listGrants(filter: BrowserGrantListFilter): BrowserPermissionGrant[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.instanceId) {
      where.push('instance_id = ?');
      params.push(filter.instanceId);
    }
    if (filter.profileId) {
      where.push('profile_id = ?');
      params.push(filter.profileId);
    }
    if (!filter.includeExpired) {
      where.push('decision = ?');
      params.push('allow');
      where.push('expires_at > ?');
      params.push(Date.now());
      where.push('revoked_at IS NULL');
      where.push('consumed_at IS NULL');
    }

    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 100);
    params.push(limit);
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM browser_permission_grants
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `,
      )
      .all<BrowserGrantRow>(...params);
    return rows.map((row) => this.map(row));
  }

  revokeGrant(grantId: string, reason?: string): BrowserPermissionGrant | null {
    this.db
      .prepare(
        `
        UPDATE browser_permission_grants
        SET revoked_at = ?, decided_by = 'revoked', reason = COALESCE(?, reason)
        WHERE id = ?
      `,
      )
      .run(Date.now(), reason ?? null, grantId);
    return this.getGrant(grantId);
  }

  consumeGrant(grantId: string): BrowserPermissionGrant | null {
    this.db
      .prepare(
        `
        UPDATE browser_permission_grants
        SET consumed_at = ?
        WHERE id = ?
      `,
      )
      .run(Date.now(), grantId);
    return this.getGrant(grantId);
  }

  private map(row: BrowserGrantRow): BrowserPermissionGrant {
    return {
      id: row.id,
      mode: row.mode,
      instanceId: row.instance_id,
      provider: row.provider,
      profileId: row.profile_id ?? undefined,
      targetId: row.target_id ?? undefined,
      allowedOrigins: this.parseJson(row.allowed_origins_json, []),
      allowedActionClasses: this.parseJson(row.allowed_action_classes_json, []),
      allowExternalNavigation: row.allow_external_navigation === 1,
      uploadRoots: row.upload_roots_json
        ? this.parseJson(row.upload_roots_json, [])
        : undefined,
      autonomous: row.autonomous === 1,
      requestedBy: row.requested_by,
      decidedBy: row.decided_by,
      decision: row.decision,
      reason: row.reason ?? undefined,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      revokedAt: row.revoked_at ?? undefined,
      consumedAt: row.consumed_at ?? undefined,
    };
  }

  private parseJson<T>(raw: string, fallback: T): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
}

let browserGrantStore: BrowserGrantStore | null = null;

export function getBrowserGrantStore(): BrowserGrantStore {
  if (!browserGrantStore) {
    browserGrantStore = new BrowserGrantStore();
  }
  return browserGrantStore;
}

export function _resetBrowserGrantStoreForTesting(): void {
  browserGrantStore = null;
}
