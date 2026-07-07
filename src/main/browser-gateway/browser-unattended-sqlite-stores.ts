import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import type {
  VaultOriginBinding,
  VaultOriginBindingStore,
} from './browser-credential-vault';
import type {
  CredentialAuthorization,
  CredentialAuthorizationRecordStore,
} from './browser-credential-authorization-store';
import type {
  BrowserEscalation,
  EscalationListFilter,
  EscalationRecordStore,
} from './browser-escalation-store';
import type {
  BrowserCampaign,
  BrowserCampaignCounters,
  BrowserCampaignStore,
} from './browser-campaign-store';

/**
 * SQLite-backed implementations of the unattended browser-automation stores
 * (tables from migration 040). Each mirrors its in-memory default and can be
 * dropped into the corresponding service. Only references/scopes/status are
 * persisted — never secrets (those live in Bitwarden).
 */

function db(): SqliteDriver {
  return getRLMDatabase().getRawDb();
}

// ── Vault origin bindings ───────────────────────────────────────────────────

interface VaultBindingRow {
  vault_item_ref: string;
  origin: string;
  username: string;
  created_at: number;
}

export class SqliteVaultOriginBindingStore implements VaultOriginBindingStore {
  constructor(private readonly driver: SqliteDriver = db()) {}

  put(binding: VaultOriginBinding): void {
    this.driver
      .prepare(
        `INSERT INTO browser_vault_item_bindings (vault_item_ref, origin, username, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(vault_item_ref) DO UPDATE SET
           origin = excluded.origin, username = excluded.username, created_at = excluded.created_at`,
      )
      .run(binding.vaultItemRef, binding.origin, binding.username, binding.createdAt);
  }

  get(vaultItemRef: string): VaultOriginBinding | undefined {
    const row = this.driver
      .prepare(`SELECT * FROM browser_vault_item_bindings WHERE vault_item_ref = ?`)
      .get<VaultBindingRow>(vaultItemRef);
    if (!row) {
      return undefined;
    }
    return {
      vaultItemRef: row.vault_item_ref,
      origin: row.origin,
      username: row.username,
      createdAt: row.created_at,
    };
  }
}

// ── Credential authorizations ───────────────────────────────────────────────

interface CredentialAuthorizationRow {
  id: string;
  profile_id: string;
  allowed_origins_json: string;
  purposes_json: string;
  vault_folder: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  note: string | null;
}

export class SqliteCredentialAuthorizationStore
  implements CredentialAuthorizationRecordStore
{
  constructor(private readonly driver: SqliteDriver = db()) {}

  insert(auth: CredentialAuthorization): void {
    this.driver
      .prepare(
        `INSERT INTO browser_credential_authorizations
           (id, profile_id, allowed_origins_json, purposes_json, vault_folder,
            created_at, expires_at, revoked_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        auth.id,
        auth.profileId,
        JSON.stringify(auth.allowedOrigins),
        JSON.stringify(auth.purposes),
        auth.vaultFolder,
        auth.createdAt,
        auth.expiresAt,
        auth.revokedAt ?? null,
        auth.note ?? null,
      );
  }

  get(id: string): CredentialAuthorization | undefined {
    const row = this.driver
      .prepare(`SELECT * FROM browser_credential_authorizations WHERE id = ?`)
      .get<CredentialAuthorizationRow>(id);
    return row ? mapAuthorization(row) : undefined;
  }

  list(filter?: { profileId?: string; includeRevoked?: boolean }): CredentialAuthorization[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.profileId) {
      clauses.push('profile_id = ?');
      params.push(filter.profileId);
    }
    if (!filter?.includeRevoked) {
      clauses.push('revoked_at IS NULL');
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.driver
      .prepare(`SELECT * FROM browser_credential_authorizations ${where}`)
      .all<CredentialAuthorizationRow>(...params)
      .map(mapAuthorization);
  }

  markRevoked(id: string, revokedAt: number): void {
    this.driver
      .prepare(`UPDATE browser_credential_authorizations SET revoked_at = ? WHERE id = ?`)
      .run(revokedAt, id);
  }
}

function mapAuthorization(row: CredentialAuthorizationRow): CredentialAuthorization {
  return {
    id: row.id,
    profileId: row.profile_id,
    allowedOrigins: JSON.parse(row.allowed_origins_json),
    purposes: JSON.parse(row.purposes_json),
    vaultFolder: row.vault_folder,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
    ...(row.note !== null ? { note: row.note } : {}),
  };
}

// ── Escalations ─────────────────────────────────────────────────────────────

interface EscalationRow {
  id: string;
  campaign_id: string | null;
  profile_id: string;
  target_id: string | null;
  kind: string;
  reason: string;
  url: string | null;
  screenshot_artifact_id: string | null;
  status: string;
  created_at: number;
  resolved_at: number | null;
  resolution_note: string | null;
}

export class SqliteEscalationRecordStore implements EscalationRecordStore {
  constructor(private readonly driver: SqliteDriver = db()) {}

  insert(escalation: BrowserEscalation): void {
    this.driver
      .prepare(
        `INSERT INTO browser_escalations
           (id, campaign_id, profile_id, target_id, kind, reason, url,
            screenshot_artifact_id, status, created_at, resolved_at, resolution_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        escalation.id,
        escalation.campaignId ?? null,
        escalation.profileId,
        escalation.targetId ?? null,
        escalation.kind,
        escalation.reason,
        escalation.url ?? null,
        escalation.screenshotArtifactId ?? null,
        escalation.status,
        escalation.createdAt,
        escalation.resolvedAt ?? null,
        escalation.resolutionNote ?? null,
      );
  }

  get(id: string): BrowserEscalation | undefined {
    const row = this.driver
      .prepare(`SELECT * FROM browser_escalations WHERE id = ?`)
      .get<EscalationRow>(id);
    return row ? mapEscalation(row) : undefined;
  }

  list(filter: EscalationListFilter = {}): BrowserEscalation[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.campaignId) {
      clauses.push('campaign_id = ?');
      params.push(filter.campaignId);
    }
    if (filter.profileId) {
      clauses.push('profile_id = ?');
      params.push(filter.profileId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.driver
      .prepare(`SELECT * FROM browser_escalations ${where} ORDER BY created_at DESC`)
      .all<EscalationRow>(...params)
      .map(mapEscalation);
  }

  update(escalation: BrowserEscalation): void {
    this.driver
      .prepare(
        `UPDATE browser_escalations
           SET status = ?, resolved_at = ?, resolution_note = ?
         WHERE id = ?`,
      )
      .run(
        escalation.status,
        escalation.resolvedAt ?? null,
        escalation.resolutionNote ?? null,
        escalation.id,
      );
  }
}

function mapEscalation(row: EscalationRow): BrowserEscalation {
  return {
    id: row.id,
    ...(row.campaign_id !== null ? { campaignId: row.campaign_id } : {}),
    profileId: row.profile_id,
    ...(row.target_id !== null ? { targetId: row.target_id } : {}),
    kind: row.kind as BrowserEscalation['kind'],
    reason: row.reason,
    ...(row.url !== null ? { url: row.url } : {}),
    ...(row.screenshot_artifact_id !== null
      ? { screenshotArtifactId: row.screenshot_artifact_id }
      : {}),
    status: row.status as BrowserEscalation['status'],
    createdAt: row.created_at,
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
    ...(row.resolution_note !== null ? { resolutionNote: row.resolution_note } : {}),
  };
}

// ── Campaigns ───────────────────────────────────────────────────────────────

interface CampaignRow {
  id: string;
  label: string;
  profile_id: string;
  allowed_origins_json: string;
  allowed_action_classes_json: string;
  budget_json: string;
  approved_declaration_hashes_json: string;
  status: string;
  created_at: number;
  expires_at: number;
  approved_by: string;
}

interface CampaignCountersRow {
  campaign_id: string;
  actions: number;
  submits: number;
  new_accounts: number;
  uploads: number;
}

export class SqliteBrowserCampaignStore implements BrowserCampaignStore {
  constructor(private readonly driver: SqliteDriver = db()) {}

  put(campaign: BrowserCampaign): void {
    this.driver
      .prepare(
        `INSERT INTO browser_campaigns
           (id, label, profile_id, allowed_origins_json, allowed_action_classes_json,
            budget_json, approved_declaration_hashes_json, status, created_at, expires_at, approved_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           allowed_origins_json = excluded.allowed_origins_json,
           allowed_action_classes_json = excluded.allowed_action_classes_json,
           budget_json = excluded.budget_json,
           approved_declaration_hashes_json = excluded.approved_declaration_hashes_json,
           status = excluded.status,
           expires_at = excluded.expires_at`,
      )
      .run(
        campaign.id,
        campaign.label,
        campaign.profileId,
        JSON.stringify(campaign.allowedOrigins),
        JSON.stringify(campaign.allowedActionClasses),
        JSON.stringify(campaign.budget),
        JSON.stringify(campaign.approvedDeclarationHashes),
        campaign.status,
        campaign.createdAt,
        campaign.expiresAt,
        campaign.approvedBy,
      );
  }

  get(id: string): BrowserCampaign | undefined {
    const row = this.driver
      .prepare(`SELECT * FROM browser_campaigns WHERE id = ?`)
      .get<CampaignRow>(id);
    return row ? mapCampaign(row) : undefined;
  }

  list(): BrowserCampaign[] {
    return this.driver
      .prepare(`SELECT * FROM browser_campaigns ORDER BY created_at DESC`)
      .all<CampaignRow>()
      .map(mapCampaign);
  }

  getCounters(id: string): BrowserCampaignCounters | undefined {
    const row = this.driver
      .prepare(`SELECT * FROM browser_campaign_counters WHERE campaign_id = ?`)
      .get<CampaignCountersRow>(id);
    if (!row) {
      return undefined;
    }
    return {
      actions: row.actions,
      submits: row.submits,
      newAccounts: row.new_accounts,
      uploads: row.uploads,
    };
  }

  putCounters(id: string, counters: BrowserCampaignCounters): void {
    this.driver
      .prepare(
        `INSERT INTO browser_campaign_counters (campaign_id, actions, submits, new_accounts, uploads)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(campaign_id) DO UPDATE SET
           actions = excluded.actions, submits = excluded.submits,
           new_accounts = excluded.new_accounts, uploads = excluded.uploads`,
      )
      .run(id, counters.actions, counters.submits, counters.newAccounts, counters.uploads);
  }
}

function mapCampaign(row: CampaignRow): BrowserCampaign {
  return {
    id: row.id,
    label: row.label,
    profileId: row.profile_id,
    allowedOrigins: JSON.parse(row.allowed_origins_json),
    allowedActionClasses: JSON.parse(row.allowed_action_classes_json),
    budget: JSON.parse(row.budget_json),
    approvedDeclarationHashes: JSON.parse(row.approved_declaration_hashes_json),
    status: row.status as BrowserCampaign['status'],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedBy: 'user',
  };
}
