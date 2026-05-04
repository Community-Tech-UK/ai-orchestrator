import type {
  BrowserAuditEntry,
  BrowserGatewayDecision,
  BrowserGatewayOutcome,
} from '@contracts/types/browser';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import { generateId } from '../../shared/utils/id-generator';

interface BrowserAuditEntryRow {
  id: string;
  instance_id: string | null;
  provider: string;
  profile_id: string | null;
  target_id: string | null;
  action: string;
  tool_name: string;
  action_class: BrowserAuditEntry['actionClass'];
  origin: string | null;
  url: string | null;
  decision: BrowserGatewayDecision;
  outcome: BrowserGatewayOutcome;
  summary: string;
  redaction_applied: number;
  screenshot_artifact_id: string | null;
  request_id: string | null;
  grant_id: string | null;
  autonomous: number | null;
  created_at: number;
}

export type BrowserAuditEntryInput = Omit<BrowserAuditEntry, 'id' | 'createdAt'>;

export interface BrowserAuditListFilter {
  profileId?: string;
  instanceId?: string;
  limit?: number;
}

export class BrowserAuditStore {
  constructor(private readonly db: SqliteDriver = getRLMDatabase().getRawDb()) {}

  record(entry: BrowserAuditEntryInput): BrowserAuditEntry {
    const id = generateId();
    const now = Date.now();
    this.db
      .prepare(
        `
        INSERT INTO browser_audit_entries
          (id, instance_id, provider, profile_id, target_id, action, tool_name,
           action_class, origin, url, decision, outcome, summary, redaction_applied,
           screenshot_artifact_id, request_id, grant_id, autonomous, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        entry.instanceId ?? null,
        entry.provider,
        entry.profileId ?? null,
        entry.targetId ?? null,
        entry.action,
        entry.toolName,
        entry.actionClass,
        entry.origin ?? null,
        entry.url ?? null,
        entry.decision,
        entry.outcome,
        entry.summary,
        entry.redactionApplied ? 1 : 0,
        entry.screenshotArtifactId ?? null,
        entry.requestId ?? null,
        entry.grantId ?? null,
        entry.autonomous === undefined ? null : entry.autonomous ? 1 : 0,
        now,
      );

    const row = this.db
      .prepare(`SELECT * FROM browser_audit_entries WHERE id = ?`)
      .get<BrowserAuditEntryRow>(id);
    if (!row) {
      throw new Error(`Browser audit entry ${id} was not created`);
    }
    return this.map(row);
  }

  list(filter: BrowserAuditListFilter): BrowserAuditEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.profileId) {
      where.push('profile_id = ?');
      params.push(filter.profileId);
    }
    if (filter.instanceId) {
      where.push('instance_id = ?');
      params.push(filter.instanceId);
    }

    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 100);
    params.push(limit);

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM browser_audit_entries
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `,
      )
      .all<BrowserAuditEntryRow>(...params);

    return rows.map((row) => this.map(row));
  }

  private map(row: BrowserAuditEntryRow): BrowserAuditEntry {
    return {
      id: row.id,
      instanceId: row.instance_id ?? undefined,
      provider: row.provider,
      profileId: row.profile_id ?? undefined,
      targetId: row.target_id ?? undefined,
      action: row.action,
      toolName: row.tool_name,
      actionClass: row.action_class,
      origin: row.origin ?? undefined,
      url: row.url ?? undefined,
      decision: row.decision,
      outcome: row.outcome,
      summary: row.summary,
      redactionApplied: row.redaction_applied === 1,
      screenshotArtifactId: row.screenshot_artifact_id ?? undefined,
      requestId: row.request_id ?? undefined,
      grantId: row.grant_id ?? undefined,
      autonomous: row.autonomous === null ? undefined : row.autonomous === 1,
      createdAt: row.created_at,
    };
  }
}

let browserAuditStore: BrowserAuditStore | null = null;

export function getBrowserAuditStore(): BrowserAuditStore {
  if (!browserAuditStore) {
    browserAuditStore = new BrowserAuditStore();
  }
  return browserAuditStore;
}

export function _resetBrowserAuditStoreForTesting(): void {
  browserAuditStore = null;
}
