import type Database from 'better-sqlite3';
import { getLogger } from '../logging/logger.js';

const logger = getLogger('PermissionDecisionStore');

export interface PermissionDecisionRecord {
  instanceId: string;
  scope: string;
  resource: string;
  action: 'allow' | 'deny' | 'ask';
  decidedBy?: string;
  ruleId?: string;
  reason?: string;
  toolName?: string;
  isCached?: boolean;
  decidedAt: string;
}

export class PermissionDecisionStore {
  constructor(private db: Database.Database) {}

  record(decision: PermissionDecisionRecord): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO permission_decisions
          (instance_id, scope, resource, action, decided_by, rule_id, reason, tool_name, is_cached, decided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        decision.instanceId,
        decision.scope,
        decision.resource,
        decision.action,
        decision.decidedBy ?? null,
        decision.ruleId ?? null,
        decision.reason ?? null,
        decision.toolName ?? null,
        decision.isCached ? 1 : 0,
        decision.decidedAt
      );
    } catch (err) {
      logger.error('Failed to record permission decision', err as Error);
    }
  }

  getByInstance(instanceId: string): PermissionDecisionRecord[] {
    try {
      const stmt = this.db.prepare(`
        SELECT
          instance_id AS instanceId,
          scope,
          resource,
          action,
          decided_by AS decidedBy,
          rule_id AS ruleId,
          reason,
          tool_name AS toolName,
          is_cached AS isCached,
          decided_at AS decidedAt
        FROM permission_decisions
        WHERE instance_id = ?
        ORDER BY created_at DESC
      `);
      return stmt.all(instanceId) as PermissionDecisionRecord[];
    } catch (err) {
      logger.error('Failed to query permission decisions', err as Error);
      return [];
    }
  }
}
