import type {
  BrowserAuditEntry,
  BrowserGatewayDecision,
  BrowserGatewayOutcome,
} from '@contracts/types/browser';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import { generateId } from '../../shared/utils/id-generator';
import type { ChromeProfileUse } from './browser-chrome-profile-choice';

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
  reason: string | null;
  redaction_applied: number;
  screenshot_artifact_id: string | null;
  request_id: string | null;
  command_id: string | null;
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
           action_class, origin, url, decision, outcome, summary, reason, redaction_applied,
           screenshot_artifact_id, request_id, command_id, grant_id, autonomous, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        entry.reason ?? null,
        entry.redactionApplied ? 1 : 0,
        entry.screenshotArtifactId ?? null,
        entry.requestId ?? null,
        entry.commandId ?? null,
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

  /**
   * Successful agent actions per Chrome profile (extension install) on one
   * computer since `since`, and how many were on `origin`. Shared-tab profile
   * ids embed the install as `existing-tab:[n.<node>:]p.<install>:...`, so a
   * range over that prefix uses the profile index.
   */
  countChromeProfileUse(query: { nodeId?: string; origin?: string; since: number }): ChromeProfileUse[] {
    const prefix = query.nodeId ? `existing-tab:n.${query.nodeId}:p.` : 'existing-tab:p.';
    const upperBound = `${prefix.slice(0, -1)}/`;
    const rows = this.db
      .prepare(
        `
        SELECT install, SUM(on_site) AS site_actions, COUNT(*) AS total_actions
        FROM (
          SELECT substr(rest, 1, instr(rest, ':') - 1) AS install,
                 CASE WHEN origin = ? THEN 1 ELSE 0 END AS on_site
          FROM (
            SELECT substr(profile_id, ?) AS rest, origin
            FROM browser_audit_entries
            WHERE profile_id >= ? AND profile_id < ? AND outcome = 'succeeded' AND created_at >= ?
          )
        )
        WHERE install <> ''
        GROUP BY install
      `,
      )
      .all<{ install: string; site_actions: number; total_actions: number }>(
        query.origin ?? null,
        prefix.length + 1,
        prefix,
        upperBound,
        query.since,
      );
    return rows.map((row) => ({
      extensionInstanceId: row.install,
      siteActions: row.site_actions,
      totalActions: row.total_actions,
    }));
  }

  /**
   * LT-217 retention pruning: deletes `actionClass: 'read'` rows older than
   * `before`. Scoped to `read` deliberately — mutating/destructive actions
   * (click, type, navigate, etc.) are the rarer, higher-value forensic record
   * and are not pruned by this path.
   */
  pruneReadEntriesBefore(before: number): number {
    return this.db
      .prepare(`DELETE FROM browser_audit_entries WHERE action_class = 'read' AND created_at < ?`)
      .run(before).changes;
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
      ...(row.reason ? { reason: row.reason } : {}),
      redactionApplied: row.redaction_applied === 1,
      screenshotArtifactId: row.screenshot_artifact_id ?? undefined,
      requestId: row.request_id ?? undefined,
      commandId: row.command_id ?? undefined,
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
