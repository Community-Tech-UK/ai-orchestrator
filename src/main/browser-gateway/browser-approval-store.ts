import type {
  BrowserApprovalRequest,
  BrowserApprovalRequestStatus,
} from '@contracts/types/browser';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import { generateId } from '../../shared/utils/id-generator';

interface BrowserApprovalRequestRow {
  id: string;
  request_id: string;
  instance_id: string;
  provider: BrowserApprovalRequest['provider'];
  profile_id: string;
  target_id: string | null;
  tool_name: string;
  action: string;
  action_class: BrowserApprovalRequest['actionClass'];
  origin: string | null;
  url: string | null;
  selector: string | null;
  element_context_json: string | null;
  file_path: string | null;
  detected_file_type: string | null;
  proposed_grant_json: string;
  status: BrowserApprovalRequestStatus;
  grant_id: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
}

export type BrowserApprovalRequestInput = Omit<
  BrowserApprovalRequest,
  'id' | 'requestId' | 'status' | 'grantId' | 'createdAt' | 'decidedAt'
>;

export interface BrowserApprovalListFilter {
  instanceId?: string;
  status?: BrowserApprovalRequestStatus;
  limit?: number;
}

export interface BrowserApprovalResolution {
  status: Extract<BrowserApprovalRequestStatus, 'approved' | 'denied' | 'expired'>;
  grantId?: string;
}

export class BrowserApprovalStore {
  constructor(private readonly db: SqliteDriver = getRLMDatabase().getRawDb()) {}

  createRequest(input: BrowserApprovalRequestInput): BrowserApprovalRequest {
    const id = generateId();
    const now = Date.now();
    this.db
      .prepare(
        `
        INSERT INTO browser_approval_requests
          (id, request_id, instance_id, provider, profile_id, target_id,
           tool_name, action, action_class, origin, url, selector,
           element_context_json, file_path, detected_file_type,
           proposed_grant_json, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `,
      )
      .run(
        id,
        id,
        input.instanceId,
        input.provider,
        input.profileId,
        input.targetId ?? null,
        input.toolName,
        input.action,
        input.actionClass,
        input.origin ?? null,
        input.url ?? null,
        input.selector ?? null,
        input.elementContext ? JSON.stringify(input.elementContext) : null,
        input.filePath ?? null,
        input.detectedFileType ?? null,
        JSON.stringify(input.proposedGrant),
        now,
        input.expiresAt,
      );
    return this.getRequest(id)!;
  }

  getRequest(requestId: string, instanceId?: string): BrowserApprovalRequest | null {
    const row = instanceId
      ? this.db
          .prepare(
            `SELECT * FROM browser_approval_requests WHERE request_id = ? AND instance_id = ?`,
          )
          .get<BrowserApprovalRequestRow>(requestId, instanceId)
      : this.db
          .prepare(`SELECT * FROM browser_approval_requests WHERE request_id = ?`)
          .get<BrowserApprovalRequestRow>(requestId);
    return row ? this.map(row) : null;
  }

  listRequests(filter: BrowserApprovalListFilter): BrowserApprovalRequest[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.instanceId) {
      where.push('instance_id = ?');
      params.push(filter.instanceId);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 100);
    params.push(limit);

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM browser_approval_requests
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `,
      )
      .all<BrowserApprovalRequestRow>(...params);
    return rows.map((row) => this.map(row));
  }

  resolveRequest(
    requestId: string,
    resolution: BrowserApprovalResolution,
  ): BrowserApprovalRequest | null {
    this.db
      .prepare(
        `
        UPDATE browser_approval_requests
        SET status = ?, grant_id = COALESCE(?, grant_id), decided_at = ?
        WHERE request_id = ?
      `,
      )
      .run(resolution.status, resolution.grantId ?? null, Date.now(), requestId);
    return this.getRequest(requestId);
  }

  private map(row: BrowserApprovalRequestRow): BrowserApprovalRequest {
    return {
      id: row.id,
      requestId: row.request_id,
      instanceId: row.instance_id,
      provider: row.provider,
      profileId: row.profile_id,
      targetId: row.target_id ?? undefined,
      toolName: row.tool_name,
      action: row.action,
      actionClass: row.action_class,
      origin: row.origin ?? undefined,
      url: row.url ?? undefined,
      selector: row.selector ?? undefined,
      elementContext: row.element_context_json
        ? this.parseJson(row.element_context_json, undefined)
        : undefined,
      filePath: row.file_path ?? undefined,
      detectedFileType: row.detected_file_type ?? undefined,
      proposedGrant: this.parseJson(row.proposed_grant_json, {
        mode: 'per_action',
        allowedOrigins: [],
        allowedActionClasses: [],
        allowExternalNavigation: false,
        autonomous: false,
      }),
      status: row.status,
      grantId: row.grant_id ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at ?? undefined,
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

let browserApprovalStore: BrowserApprovalStore | null = null;

export function getBrowserApprovalStore(): BrowserApprovalStore {
  if (!browserApprovalStore) {
    browserApprovalStore = new BrowserApprovalStore();
  }
  return browserApprovalStore;
}

export function _resetBrowserApprovalStoreForTesting(): void {
  browserApprovalStore = null;
}
