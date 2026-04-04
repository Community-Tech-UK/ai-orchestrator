import type Database from 'better-sqlite3';
import type { WorkflowExecution } from '../../shared/types/workflow.types.js';
import { getLogger } from '../logging/logger.js';

const logger = getLogger('WorkflowPersistence');

export class WorkflowPersistence {
  constructor(private db: Database.Database) {}

  save(execution: WorkflowExecution): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO workflow_executions
          (id, instance_id, template_id, status, current_phase_id,
           phase_statuses_json, phase_data_json, pending_gate_json,
           started_at, completed_at, agent_invocations, total_tokens, total_cost,
           updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      const status = execution.completedAt ? 'completed' : 'active';
      stmt.run(
        execution.id,
        execution.instanceId,
        execution.templateId,
        status,
        execution.currentPhaseId ?? null,
        JSON.stringify(execution.phaseStatuses),
        JSON.stringify(execution.phaseData),
        execution.pendingGate ? JSON.stringify(execution.pendingGate) : null,
        execution.startedAt,
        execution.completedAt ?? null,
        execution.agentInvocations,
        execution.totalTokens,
        execution.totalCost,
      );
    } catch (err) {
      logger.error('Failed to save workflow execution', err as Error);
    }
  }

  loadById(id: string): WorkflowExecution | undefined {
    try {
      const stmt = this.db.prepare('SELECT * FROM workflow_executions WHERE id = ?');
      const row = stmt.get(id) as Record<string, unknown> | undefined;
      return row ? this.deserialize(row) : undefined;
    } catch (err) {
      logger.error('Failed to load workflow execution', err as Error);
      return undefined;
    }
  }

  loadActive(): WorkflowExecution[] {
    try {
      const stmt = this.db.prepare("SELECT * FROM workflow_executions WHERE status = 'active' ORDER BY started_at DESC");
      const rows = stmt.all() as Record<string, unknown>[];
      return rows.map(row => this.deserialize(row));
    } catch (err) {
      logger.error('Failed to load active executions', err as Error);
      return [];
    }
  }

  loadByInstance(instanceId: string): WorkflowExecution[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM workflow_executions WHERE instance_id = ? ORDER BY started_at DESC');
      const rows = stmt.all(instanceId) as Record<string, unknown>[];
      return rows.map(row => this.deserialize(row));
    } catch (err) {
      logger.error('Failed to load executions for instance', err as Error);
      return [];
    }
  }

  private deserialize(row: Record<string, unknown>): WorkflowExecution {
    return {
      id: row['id'] as string,
      instanceId: row['instance_id'] as string,
      templateId: row['template_id'] as string,
      currentPhaseId: (row['current_phase_id'] as string) ?? '',
      phaseStatuses: JSON.parse((row['phase_statuses_json'] as string) || '{}'),
      phaseData: JSON.parse((row['phase_data_json'] as string) || '{}'),
      pendingGate: row['pending_gate_json'] ? JSON.parse(row['pending_gate_json'] as string) : undefined,
      startedAt: row['started_at'] as number,
      completedAt: (row['completed_at'] as number) ?? undefined,
      agentInvocations: row['agent_invocations'] as number,
      totalTokens: row['total_tokens'] as number,
      totalCost: row['total_cost'] as number,
    };
  }
}
