import type {
  BrowserApprovalRequest,
  BrowserApprovalRequestStatus,
  BrowserCredentialAccessMetadata,
} from '@contracts/types/browser';
import { BrowserCredentialAccessMetadataSchema } from '@contracts/schemas/browser';
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
  credential_access_json: string | null;
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
           proposed_grant_json, credential_access_json, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
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
        input.credentialAccess ? JSON.stringify(BrowserCredentialAccessMetadataSchema.parse(input.credentialAccess)) : null,
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

  /** Exact indexed lookup, independent of the operator UI's 100-row page limit. */
  findCredentialAccessRequest(metadata: BrowserCredentialAccessMetadata): BrowserApprovalRequest | null {
    const row = this.db.prepare(`SELECT * FROM browser_approval_requests
      WHERE credential_access_json IS NOT NULL
        AND status <> 'expired'
        AND json_extract(credential_access_json, '$.taskScope') = ?
        AND json_extract(credential_access_json, '$.origin') = ?
        AND json_extract(credential_access_json, '$.scope') = ?
        AND json_extract(credential_access_json, '$.computerId') = ?
        AND json_extract(credential_access_json, '$.vaultItemRef') = ?
        AND json_extract(credential_access_json, '$.purposes') = ?
      ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC, id DESC LIMIT 1`).get<BrowserApprovalRequestRow>(metadata.taskScope,
        metadata.origin, metadata.scope, metadata.computerId, metadata.vaultItemRef, JSON.stringify(metadata.purposes));
    return row ? this.map(row) : null;
  }

  findCredentialAccessByGrant(grantId: string): BrowserApprovalRequest | null {
    const row = this.db.prepare(`SELECT * FROM browser_approval_requests
      WHERE grant_id = ? AND credential_access_json IS NOT NULL LIMIT 1`).get<BrowserApprovalRequestRow>(grantId);
    return row ? this.map(row) : null;
  }

  /** All live credential/approval/grant stores share this database connection. */
  commitCredentialAccessDecision<T>(apply: () => T): T {
    return this.db.transaction(apply)();
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

  /** Credential decisions never overwrite a competing or already-final decision. */
  resolveCredentialAccessRequest(
    requestId: string,
    expectedStatus: BrowserApprovalRequestStatus,
    resolution: BrowserApprovalResolution,
  ): BrowserApprovalRequest | null {
    this.db.prepare(`UPDATE browser_approval_requests
      SET status = ?, grant_id = COALESCE(?, grant_id), decided_at = ?
      WHERE request_id = ? AND status = ? AND credential_access_json IS NOT NULL`)
      .run(resolution.status, resolution.grantId ?? null, Date.now(), requestId, expectedStatus);
    return this.getRequest(requestId);
  }

  updateCredentialAccess(
    requestId: string,
    metadata: BrowserCredentialAccessMetadata,
    target?: { instanceId: string; profileId: string; targetId: string },
  ): BrowserApprovalRequest | null {
    const safeMetadata = BrowserCredentialAccessMetadataSchema.parse(metadata);
    const result = this.db.prepare(`UPDATE browser_approval_requests
      SET credential_access_json = ?, instance_id = COALESCE(?, instance_id),
          profile_id = COALESCE(?, profile_id), target_id = COALESCE(?, target_id)
      WHERE request_id = ? AND status = 'pending' AND credential_access_json IS NOT NULL`)
      .run(JSON.stringify(safeMetadata), target?.instanceId ?? null, target?.profileId ?? null, target?.targetId ?? null, requestId);
    return result.changes > 0 ? this.getRequest(requestId) : null;
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
      ...(row.credential_access_json ? { credentialAccess: BrowserCredentialAccessMetadataSchema.parse(JSON.parse(row.credential_access_json)) } : {}),
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
