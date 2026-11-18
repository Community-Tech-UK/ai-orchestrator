import type {
  BrowserApprovalRequest,
  BrowserApprovalRequestStatus,
  BrowserCredentialAccessMetadata,
  BrowserDeviceLoginMetadata,
  BrowserSecretRecoveryMetadata,
  BrowserSecretRecoveryProgress,
} from '@contracts/types/browser';
import {
  BrowserApprovalRequestSchema,
  BrowserCredentialAccessMetadataSchema,
  BrowserDeviceLoginMetadataSchema,
  BrowserSecretRecoveryMetadataSchema,
  BrowserSecretRecoveryProgressSchema,
} from '@contracts/schemas/browser';
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
  device_login_json: string | null;
  secret_recovery_json: string | null;
  secret_recovery_progress_json: string | null;
  request_reason: string | null;
  proposed_grant_json: string;
  status: BrowserApprovalRequestStatus;
  grant_id: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
}

/** `computerId` is worked out when the list is read, so it is not something a caller can store. */
export type BrowserApprovalRequestInput = Omit<
  BrowserApprovalRequest,
  'id' | 'requestId' | 'status' | 'grantId' | 'createdAt' | 'decidedAt' | 'computerId' | 'secretRecoveryProgress'
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
    const deviceLogin = input.deviceLogin ? BrowserDeviceLoginMetadataSchema.parse(input.deviceLogin) : undefined;
    if (deviceLogin) {
      BrowserApprovalRequestSchema.parse({ ...input, deviceLogin, id, requestId: id, status: 'pending', createdAt: now });
      if (input.expiresAt <= now) throw new Error('device_login_approval_expired');
    }
    const secretRecovery = input.secretRecovery ? BrowserSecretRecoveryMetadataSchema.parse(input.secretRecovery) : undefined;
    if (secretRecovery) {
      BrowserApprovalRequestSchema.parse({ ...input, secretRecovery, id, requestId: id, status: 'pending', createdAt: now });
      if (input.expiresAt <= now) throw new Error('secret_recovery_approval_expired');
    }
    this.db
      .prepare(
        `
        INSERT INTO browser_approval_requests
          (id, request_id, instance_id, provider, profile_id, target_id,
           tool_name, action, action_class, origin, url, selector,
           element_context_json, file_path, detected_file_type,
           proposed_grant_json, credential_access_json, device_login_json, secret_recovery_json, request_reason, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
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
        deviceLogin ? JSON.stringify(deviceLogin) : null,
        secretRecovery ? JSON.stringify(secretRecovery) : null,
        input.requestReason ?? null,
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

  /**
   * A discarded runtime cannot answer pending approvals; retain only their audit
   * history. An approved secret recovery that has not finished is stopped too,
   * so a stopped task can never have its protection released afterwards.
   */
  expireForInstance(instanceId: string): number {
    return this.db.prepare(`UPDATE browser_approval_requests SET status = 'expired', decided_at = ?
      WHERE instance_id = ? AND (status = 'pending' OR (status = 'approved' AND secret_recovery_json IS NOT NULL
        AND (secret_recovery_progress_json IS NULL
          OR json_extract(secret_recovery_progress_json, '$.state') <> 'recovered')))`).run(Date.now(), instanceId).changes;
  }

  /** A stopped or closed session's pending or unfinished secret recoveries can never run. */
  expireSecretRecoveriesForInstance(instanceId: string): number {
    return this.db.prepare(`UPDATE browser_approval_requests SET status = 'expired', decided_at = ?
      WHERE instance_id = ? AND secret_recovery_json IS NOT NULL AND (status = 'pending' OR (status = 'approved'
        AND (secret_recovery_progress_json IS NULL
          OR json_extract(secret_recovery_progress_json, '$.state') <> 'recovered')))`).run(Date.now(), instanceId).changes;
  }

  /**
   * The newest recovery approval for this exact review (session, computer, tab,
   * origins and write generation) that can still be reused: pending, or
   * approved and not yet finished. Expired, denied and finished ones never are.
   */
  findReusableSecretRecoveryRequest(binding: Pick<BrowserSecretRecoveryMetadata,
    'ownerSessionId' | 'nodeId' | 'targetId' | 'origins' | 'writeGeneration'>): BrowserApprovalRequest | null {
    const row = this.db.prepare(`SELECT * FROM browser_approval_requests
      WHERE secret_recovery_json IS NOT NULL AND status IN ('pending', 'approved') AND expires_at > ?
        AND json_extract(secret_recovery_json, '$.ownerSessionId') = ?
        AND json_extract(secret_recovery_json, '$.nodeId') = ?
        AND json_extract(secret_recovery_json, '$.targetId') = ?
        AND json_extract(secret_recovery_json, '$.writeGeneration') = ?
        AND json_extract(secret_recovery_json, '$.origins') = ?
        AND (secret_recovery_progress_json IS NULL
          OR json_extract(secret_recovery_progress_json, '$.state') IN ('running', 'failed', 'indeterminate'))
      ORDER BY created_at DESC, id DESC LIMIT 1`).get<BrowserApprovalRequestRow>(Date.now(), binding.ownerSessionId,
      binding.nodeId, binding.targetId, binding.writeGeneration, JSON.stringify(binding.origins));
    return row ? this.map(row) : null;
  }

  /** An operator decision compares the exact metadata and wins only while pending. */
  resolveSecretRecoveryRequest(requestId: string, metadata: BrowserSecretRecoveryMetadata,
    decision: 'approved' | 'denied'): BrowserApprovalRequest | null {
    const safe = BrowserSecretRecoveryMetadataSchema.safeParse(metadata);
    if (!safe.success) return null;
    const now = Date.now();
    const result = this.db.prepare(`UPDATE browser_approval_requests SET status = ?, decided_at = ?
      WHERE request_id = ? AND status = 'pending' AND expires_at > ? AND secret_recovery_json = ?`)
      .run(decision, now, requestId, now, JSON.stringify(safe.data));
    return result.changes > 0 ? this.getRequest(requestId) : null;
  }

  /**
   * Records what Harness did, only while the recovery is still approved. A
   * result carrying a release receipt is recorded even if Stop or expiry ended
   * the approval meanwhile, and a stored receipt is never overwritten by a
   * result without one: the release happened and must not be hidden.
   */
  setSecretRecoveryProgress(requestId: string, progress: BrowserSecretRecoveryProgress): BrowserApprovalRequest | null {
    const safe = BrowserSecretRecoveryProgressSchema.parse(progress);
    const result = this.db.prepare(`UPDATE browser_approval_requests SET secret_recovery_progress_json = ?
      WHERE request_id = ? AND secret_recovery_json IS NOT NULL
        AND (status = 'approved' OR (status = 'expired' AND ? IS NOT NULL))
        AND (secret_recovery_progress_json IS NULL
          OR json_extract(secret_recovery_progress_json, '$.receiptId') IS NULL OR ? IS NOT NULL)`)
      .run(JSON.stringify(safe), requestId, safe.receiptId ?? null, safe.receiptId ?? null);
    return result.changes > 0 ? this.getRequest(requestId) : null;
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
        AND json_extract(credential_access_json, '$.senderDomains') IS ?
      ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC, id DESC LIMIT 1`).get<BrowserApprovalRequestRow>(metadata.taskScope,
        metadata.origin, metadata.scope, metadata.computerId, metadata.vaultItemRef, JSON.stringify(metadata.purposes),
        metadata.senderDomains ? JSON.stringify(metadata.senderDomains) : null);
    return row ? this.map(row) : null;
  }

  /**
   * Whether James said no to this saved login on this site in this task, whatever was
   * asked or on which computer. A request that failed or that its agent cancelled
   * (operationError set) is not his no (brief 18 Nov 2026, item 3).
   */
  hasDeniedCredentialAccess(taskScope: string, vaultItemRef: string, origin: string): boolean {
    return this.db.prepare(`SELECT 1 FROM browser_approval_requests
      WHERE credential_access_json IS NOT NULL AND status = 'denied'
        AND json_extract(credential_access_json, '$.operationError') IS NULL
        AND json_extract(credential_access_json, '$.taskScope') = ?
        AND json_extract(credential_access_json, '$.vaultItemRef') = ?
        AND json_extract(credential_access_json, '$.origin') = ? LIMIT 1`).get(taskScope, vaultItemRef, origin) !== undefined;
  }

  /** Exact operation lookup, including expired/denied tombstones so retries cannot renew consent. */
  findDeviceLoginRequest(metadata: BrowserDeviceLoginMetadata): BrowserApprovalRequest | null {
    const safe = BrowserDeviceLoginMetadataSchema.safeParse(metadata);
    if (!safe.success) return null;
    const row = this.db.prepare(`SELECT * FROM browser_approval_requests
      WHERE device_login_json IS NOT NULL AND json_extract(device_login_json, '$.operationHandle') = ?
        AND json_extract(device_login_json, '$.ownerSessionId') = ?
        AND json_extract(device_login_json, '$.ownerGeneration') = ?`)
      .get<BrowserApprovalRequestRow>(safe.data.operationHandle, safe.data.ownerSessionId, safe.data.ownerGeneration);
    if (!row || row.device_login_json !== JSON.stringify(safe.data)) return null;
    this.expireDeviceLoginRequest(row.request_id);
    return this.getRequest(row.request_id);
  }

  /** An operator decision compares the exact metadata and wins only while pending. */
  resolveDeviceLoginRequest(requestId: string, metadata: BrowserDeviceLoginMetadata,
    decision: 'approved' | 'denied'): BrowserApprovalRequest | null {
    const safe = BrowserDeviceLoginMetadataSchema.safeParse(metadata);
    if (!safe.success) return null;
    this.expireDeviceLoginRequest(requestId);
    const result = this.db.prepare(`UPDATE browser_approval_requests SET status = ?, decided_at = ?
      WHERE request_id = ? AND status = 'pending' AND expires_at > ? AND device_login_json = ?`)
      .run(decision, Date.now(), requestId, Date.now(), JSON.stringify(safe.data));
    return result.changes > 0 ? this.getRequest(requestId) : null;
  }

  expireDeviceLoginRequest(requestId: string): BrowserApprovalRequest | null {
    this.db.prepare(`UPDATE browser_approval_requests SET status = 'expired', decided_at = ?
      WHERE request_id = ? AND device_login_json IS NOT NULL AND status IN ('pending', 'approved') AND expires_at <= ?`)
      .run(Date.now(), requestId, Date.now());
    return this.getRequest(requestId);
  }

  invalidateDeviceLoginRequests(operationHandle: string, owner: { sessionId: string; generation: string }): void {
    this.db.prepare(`UPDATE browser_approval_requests SET status = 'expired', decided_at = ?
      WHERE status IN ('pending', 'approved') AND device_login_json IS NOT NULL
        AND json_extract(device_login_json, '$.operationHandle') = ?
        AND json_extract(device_login_json, '$.ownerSessionId') = ?
        AND json_extract(device_login_json, '$.ownerGeneration') = ?`)
      .run(Date.now(), operationHandle, owner.sessionId, owner.generation);
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
        WHERE request_id = ? AND device_login_json IS NULL
          AND (secret_recovery_json IS NULL OR ? <> 'approved')
      `,
      )
      // Only resolveSecretRecoveryRequest, with the exact metadata, may approve a recovery.
      .run(resolution.status, resolution.grantId ?? null, Date.now(), requestId, resolution.status);
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
      ...(row.device_login_json ? { deviceLogin: BrowserDeviceLoginMetadataSchema.parse(JSON.parse(row.device_login_json)) } : {}),
      ...(row.secret_recovery_json
        ? { secretRecovery: BrowserSecretRecoveryMetadataSchema.parse(JSON.parse(row.secret_recovery_json)) }
        : {}),
      ...(row.secret_recovery_progress_json
        ? { secretRecoveryProgress: BrowserSecretRecoveryProgressSchema.parse(JSON.parse(row.secret_recovery_progress_json)) }
        : {}),
      ...(row.request_reason ? { requestReason: row.request_reason } : {}),
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
