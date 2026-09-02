import * as crypto from 'crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import { getSafeStorage, type SafeStorageAccessor } from '../session/safe-storage-accessor';
import { getLogger } from '../logging/logger';
import {
  registerExactSecretValue,
  unregisterExactSecretValue,
} from '../security/secret-detector';
import { isUnscopedWorkspace } from './secret-workspace-key';

const logger = getLogger('WorkspaceSecretStore');

/**
 * Workspace Secret Store — encrypted storage for user-supplied credentials captured
 * by the inline secure secret card.
 *
 * Security contract (the reason this module exists):
 *  - The model NEVER sees a stored value. Agents receive only an opaque
 *    `secret://<name>` reference. `resolve()` is the ONLY method that returns
 *    plaintext, and it is for main-process callers that inject the value into an
 *    outbound call — never for a tool result.
 *  - Values are encrypted at rest with Electron safeStorage and FAIL CLOSED: if
 *    encryption is unavailable the store refuses to write rather than persisting
 *    plaintext.
 *  - Secrets are SCOPED PER WORKSPACE. A resolve for a workspace other than the
 *    one that owns the secret is refused regardless of what the caller claims.
 *  - Secrets are never placed in thrown errors or log lines. Every log site here
 *    records name/workspace/length only.
 *
 * Fully injectable (db, safeStorage, clock, id generator) so unit tests run with no
 * Electron, no keychain, and no real secret.
 */

export type WorkspaceSecretAuditEvent =
  | 'created'
  | 'updated'
  | 'resolved'
  | 'declined'
  | 'forgotten';

/** Metadata safe to display. Deliberately has no value field. */
export interface WorkspaceSecretMetadata {
  id: string;
  workspaceId: string;
  name: string;
  label: string;
  purpose: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface PutSecretInput {
  workspaceId: string;
  name: string;
  label?: string;
  purpose?: string;
  value: string;
  instanceId?: string;
}

interface SecretRow {
  id: string;
  workspace_id: string;
  name: string;
  label: string;
  purpose: string;
  value_enc: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export class SafeStorageUnavailableError extends Error {
  constructor() {
    super('SAFESTORAGE_UNAVAILABLE: cannot store a secret without OS encryption');
    this.name = 'SafeStorageUnavailableError';
  }
}

export interface WorkspaceSecretStoreDeps {
  db?: SqliteDriver;
  safeStorage?: SafeStorageAccessor;
  now?: () => number;
  newId?: () => string;
}

export class WorkspaceSecretStore {
  private readonly db: SqliteDriver;
  private readonly safeStorageFactory: () => SafeStorageAccessor;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: WorkspaceSecretStoreDeps = {}) {
    this.db = deps.db ?? getRLMDatabase().getRawDb();
    this.safeStorageFactory = deps.safeStorage ? () => deps.safeStorage as SafeStorageAccessor : getSafeStorage;
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Store or replace a secret for a workspace.
   *
   * @throws SafeStorageUnavailableError when the OS cannot encrypt — never falls back
   *         to plaintext.
   */
  put(input: PutSecretInput): WorkspaceSecretMetadata {
    this.assertScoped(input.workspaceId);
    const name = normaliseName(input.name);
    if (!input.value) throw new Error('A secret value is required');

    const safeStorage = this.safeStorageFactory();
    if (!safeStorage.isEncryptionAvailable()) {
      // Deliberately no value, and no hint of one, in this error.
      logger.warn('Refusing to store secret; safeStorage unavailable', {
        workspaceId: input.workspaceId,
        name,
      });
      throw new SafeStorageUnavailableError();
    }
    const valueEnc = safeStorage.encryptString(input.value).toString('base64');

    const at = this.now();
    const existing = this.getRow(input.workspaceId, name);
    const id = existing?.id ?? this.newId();

    this.db.prepare(`
      INSERT INTO workspace_secrets
        (id, workspace_id, name, label, purpose, value_enc, created_at, updated_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(workspace_id, name) DO UPDATE SET
        label = excluded.label,
        purpose = excluded.purpose,
        value_enc = excluded.value_enc,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.workspaceId,
      name,
      input.label ?? existing?.label ?? '',
      input.purpose ?? existing?.purpose ?? '',
      valueEnc,
      existing?.created_at ?? at,
      at,
    );

    this.audit({
      workspaceId: input.workspaceId,
      secretName: name,
      event: existing ? 'updated' : 'created',
      instanceId: input.instanceId,
      purpose: input.purpose ?? '',
    });

    logger.info('Stored workspace secret', {
      workspaceId: input.workspaceId,
      name,
      valueLength: input.value.length,
      replaced: Boolean(existing),
    });

    if (existing) {
      this.unregisterStoredValue(existing);
    }
    registerExactSecretValue(input.value, name);

    return this.requireMetadata(input.workspaceId, name);
  }

  /**
   * Return plaintext to a main-process consumer only. Never log or throw the value.
   * `ref` may be `secret://<name>` or a bare name.
   */
  resolve(
    ref: string,
    opts: { workspaceId: string; purpose?: string; instanceId?: string },
  ): string {
    this.assertScoped(opts.workspaceId);
    const name = parseSecretRef(ref);
    const row = this.getRow(opts.workspaceId, name);
    if (!row) {
      throw new Error('That workspace secret does not exist');
    }

    let value: string;
    try {
      value = this.safeStorageFactory().decryptString(Buffer.from(row.value_enc, 'base64'));
    } catch {
      logger.error('Failed to decrypt workspace secret', undefined, {
        workspaceId: opts.workspaceId,
        name,
      });
      throw new Error('That workspace secret could not be decrypted');
    }

    const at = this.now();
    this.db.prepare(`
      UPDATE workspace_secrets SET last_used_at = ? WHERE workspace_id = ? AND name = ?
    `).run(at, opts.workspaceId, name);

    this.audit({
      workspaceId: opts.workspaceId,
      secretName: name,
      event: 'resolved',
      instanceId: opts.instanceId,
      purpose: opts.purpose ?? '',
    });

    logger.info('Resolved workspace secret', {
      workspaceId: opts.workspaceId,
      name,
      valueLength: value.length,
    });

    return value;
  }

  /** Metadata for every secret in a workspace. Never returns values. */
  list(workspaceId: string): WorkspaceSecretMetadata[] {
    return this.db.prepare(`
      SELECT id, workspace_id, name, label, purpose, value_enc, created_at, updated_at, last_used_at
      FROM workspace_secrets
      WHERE workspace_id = ?
      ORDER BY name
    `).all<SecretRow>(workspaceId).map(toMetadata);
  }

  has(workspaceId: string, name: string): boolean {
    return Boolean(this.getRow(workspaceId, normaliseName(name)));
  }

  /** Delete a secret. Returns true when a row was removed. */
  forget(workspaceId: string, name: string, instanceId?: string): boolean {
    const normalised = normaliseName(name);
    const existing = this.getRow(workspaceId, normalised);
    const result = this.db.prepare(`
      DELETE FROM workspace_secrets WHERE workspace_id = ? AND name = ?
    `).run(workspaceId, normalised);

    const removed = result.changes > 0;
    if (removed) {
      if (existing) {
        this.unregisterStoredValue(existing);
      }
      this.audit({
        workspaceId,
        secretName: normalised,
        event: 'forgotten',
        instanceId,
        purpose: '',
      });
      logger.info('Forgot workspace secret', { workspaceId, name: normalised });
    }
    return removed;
  }

  /** Record that the user refused a request. No value is involved. */
  recordDeclined(workspaceId: string, name: string, instanceId?: string): void {
    this.audit({
      workspaceId,
      secretName: normaliseName(name),
      event: 'declined',
      instanceId,
      purpose: '',
    });
  }

  auditTrail(workspaceId: string, limit = 100): Array<{
    id: string;
    workspaceId: string;
    secretName: string;
    event: WorkspaceSecretAuditEvent;
    instanceId: string | null;
    purpose: string;
    at: number;
  }> {
    return this.db.prepare(`
      SELECT id, workspace_id, secret_name, event, instance_id, purpose, at
      FROM workspace_secret_audit
      WHERE workspace_id = ?
      ORDER BY at DESC
      LIMIT ?
    `).all<{
      id: string;
      workspace_id: string;
      secret_name: string;
      event: WorkspaceSecretAuditEvent;
      instance_id: string | null;
      purpose: string;
      at: number;
    }>(workspaceId, limit).map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      secretName: row.secret_name,
      event: row.event,
      instanceId: row.instance_id,
      purpose: row.purpose,
      at: row.at,
    }));
  }

  private assertScoped(workspaceId: string): void {
    if (!workspaceId || isUnscopedWorkspace(workspaceId)) {
      throw new Error(
        'A workspace secret requires a real working directory; the unscoped workspace is refused',
      );
    }
  }

  private getRow(workspaceId: string, name: string): SecretRow | undefined {
    return this.db.prepare(`
      SELECT id, workspace_id, name, label, purpose, value_enc, created_at, updated_at, last_used_at
      FROM workspace_secrets
      WHERE workspace_id = ? AND name = ?
    `).get<SecretRow>(workspaceId, name);
  }

  private unregisterStoredValue(row: SecretRow): void {
    try {
      const value = this.safeStorageFactory().decryptString(Buffer.from(row.value_enc, 'base64'));
      unregisterExactSecretValue(value);
    } catch {
      // The row is still deleted; a stale matcher is a fail-closed leftover.
    }
  }

  private requireMetadata(workspaceId: string, name: string): WorkspaceSecretMetadata {
    const row = this.getRow(workspaceId, name);
    if (!row) throw new Error(`Secret ${name} was not persisted`);
    return toMetadata(row);
  }

  private audit(entry: {
    workspaceId: string;
    secretName: string;
    event: WorkspaceSecretAuditEvent;
    instanceId?: string;
    purpose: string;
  }): void {
    this.db.prepare(`
      INSERT INTO workspace_secret_audit (id, workspace_id, secret_name, event, instance_id, purpose, at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.newId(),
      entry.workspaceId,
      entry.secretName,
      entry.event,
      entry.instanceId ?? null,
      entry.purpose,
      this.now(),
    );
  }
}

/** Accept `secret://name` or a bare slug. Never returns the secret value. */
export function parseSecretRef(ref: string): string {
  const trimmed = (ref ?? '').trim();
  const name = trimmed.startsWith('secret://') ? trimmed.slice('secret://'.length) : trimmed;
  return normaliseName(name);
}

/** Slug form so `GitHub PAT` and `github-pat` cannot become two secrets. */
export function normaliseName(name: string): string {
  const slug = (name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('A secret name is required');
  return slug;
}

function toMetadata(row: SecretRow): WorkspaceSecretMetadata {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    label: row.label,
    purpose: row.purpose,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

let workspaceSecretStore: WorkspaceSecretStore | null = null;

export function getWorkspaceSecretStore(): WorkspaceSecretStore {
  if (!workspaceSecretStore) {
    workspaceSecretStore = new WorkspaceSecretStore();
  }
  return workspaceSecretStore;
}

export function _resetWorkspaceSecretStoreForTesting(): void {
  workspaceSecretStore = null;
}
