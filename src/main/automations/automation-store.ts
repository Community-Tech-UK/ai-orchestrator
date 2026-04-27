import type { SqliteDriver } from '../db/sqlite-driver';
import { generateId } from '../../shared/utils/id-generator';
import type {
  Automation,
  AutomationAction,
  AutomationConfigSnapshot,
  AutomationConcurrencyPolicy,
  AutomationFireOutcome,
  AutomationMissedRunPolicy,
  AutomationRun,
  AutomationRunStatus,
  AutomationSchedule,
  AutomationTrigger,
  ClaimedAutomationRun,
  CreateAutomationInput,
  UpdateAutomationInput,
} from '../../shared/types/automation.types';
import { AutomationAttachmentService } from './automation-attachment-service';

interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  active: number;
  schedule_type: 'cron' | 'oneTime';
  schedule_json: string;
  missed_run_policy: AutomationMissedRunPolicy;
  concurrency_policy: AutomationConcurrencyPolicy;
  action_json: string;
  next_fire_at: number | null;
  last_fired_at: number | null;
  last_run_id: string | null;
  created_at: number;
  updated_at: number;
  unread_run_count?: number;
}

interface AutomationRunRow {
  id: string;
  automation_id: string;
  status: AutomationRunStatus;
  trigger: AutomationTrigger;
  scheduled_at: number;
  started_at: number | null;
  finished_at: number | null;
  instance_id: string | null;
  error: string | null;
  output_summary: string | null;
  seen_at: number | null;
  config_snapshot_json: string | null;
  created_at: number;
  updated_at: number;
}

type FireDecision =
  | { kind: 'missing'; reason: string }
  | { kind: 'skipped'; reason: string; run?: AutomationRun }
  | { kind: 'queued'; run: AutomationRun }
  | { kind: 'started'; run: AutomationRun };

function stripAttachmentData(action: AutomationAction): AutomationAction {
  const { attachments, ...rest } = action;
  void attachments;
  return rest;
}

function toSnapshot(automation: Automation): AutomationConfigSnapshot {
  return {
    name: automation.name,
    schedule: automation.schedule,
    missedRunPolicy: automation.missedRunPolicy,
    concurrencyPolicy: automation.concurrencyPolicy,
    action: automation.action,
  };
}

export class AutomationStore {
  constructor(
    private readonly db: SqliteDriver,
    private readonly attachmentService = new AutomationAttachmentService(db),
  ) {}

  async create(input: CreateAutomationInput, nextFireAt: number | null, now = Date.now()): Promise<Automation> {
    const id = generateId();
    const prepared = await this.attachmentService.prepare(id, input.action.attachments, now);
    const schedule = input.schedule;
    const missedRunPolicy = input.missedRunPolicy ?? 'notify';
    const concurrencyPolicy = input.concurrencyPolicy ?? 'skip';

    const insert = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO automations
          (id, name, description, enabled, active, schedule_type, schedule_json,
           missed_run_policy, concurrency_policy, action_json, next_fire_at,
           last_fired_at, last_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      `).run(
        id,
        input.name,
        input.description ?? null,
        input.enabled === false ? 0 : 1,
        1,
        schedule.type,
        JSON.stringify(schedule),
        missedRunPolicy,
        concurrencyPolicy,
        JSON.stringify(stripAttachmentData(input.action)),
        nextFireAt,
        now,
        now,
      );
      this.attachmentService.replacePrepared(id, prepared);
    });
    insert();

    const automation = await this.get(id);
    if (!automation) {
      throw new Error(`Automation ${id} was not created`);
    }
    return automation;
  }

  async update(
    id: string,
    updates: UpdateAutomationInput,
    nextFireAt: number | null | undefined,
    now = Date.now(),
  ): Promise<Automation> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Automation ${id} not found`);
    }

    const mergedAction = updates.action ? { ...existing.action, ...updates.action } : existing.action;
    const hasAttachmentUpdate = updates.action && Object.prototype.hasOwnProperty.call(updates.action, 'attachments');
    const prepared = hasAttachmentUpdate
      ? await this.attachmentService.prepare(id, mergedAction.attachments, now)
      : undefined;

    const schedule = updates.schedule ?? existing.schedule;
    const setNextFireAt = nextFireAt !== undefined ? nextFireAt : existing.nextFireAt;

    const write = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE automations
        SET name = ?,
            description = ?,
            enabled = ?,
            active = ?,
            schedule_type = ?,
            schedule_json = ?,
            missed_run_policy = ?,
            concurrency_policy = ?,
            action_json = ?,
            next_fire_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        updates.name ?? existing.name,
        updates.description ?? existing.description ?? null,
        (updates.enabled ?? existing.enabled) ? 1 : 0,
        (updates.active ?? existing.active) ? 1 : 0,
        schedule.type,
        JSON.stringify(schedule),
        updates.missedRunPolicy ?? existing.missedRunPolicy,
        updates.concurrencyPolicy ?? existing.concurrencyPolicy,
        JSON.stringify(stripAttachmentData(mergedAction)),
        setNextFireAt,
        now,
        id,
      );
      if (prepared) {
        this.attachmentService.replacePrepared(id, prepared);
      }
    });
    write();

    const automation = await this.get(id);
    if (!automation) {
      throw new Error(`Automation ${id} disappeared during update`);
    }
    return automation;
  }

  async get(id: string): Promise<Automation | null> {
    const row = this.db.prepare(`
      SELECT a.*,
             (SELECT COUNT(*)
              FROM automation_runs r
              WHERE r.automation_id = a.id
                AND r.status IN ('succeeded', 'failed', 'skipped', 'cancelled')
                AND r.seen_at IS NULL) AS unread_run_count
      FROM automations a
      WHERE a.id = ?
    `).get<AutomationRow>(id);
    return row ? this.mapAutomation(row) : null;
  }

  async list(): Promise<Automation[]> {
    const rows = this.db.prepare(`
      SELECT a.*,
             (SELECT COUNT(*)
              FROM automation_runs r
              WHERE r.automation_id = a.id
                AND r.status IN ('succeeded', 'failed', 'skipped', 'cancelled')
                AND r.seen_at IS NULL) AS unread_run_count
      FROM automations a
      ORDER BY active DESC, enabled DESC, next_fire_at IS NULL ASC, next_fire_at ASC, updated_at DESC
    `).all<AutomationRow>();

    const automations: Automation[] = [];
    for (const row of rows) {
      automations.push(await this.mapAutomation(row));
    }
    return automations;
  }

  listSchedulable(): Automation[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM automations
      WHERE active = 1 AND enabled = 1 AND next_fire_at IS NOT NULL
    `).all<AutomationRow>();

    return rows.map((row) => this.mapAutomationSync(row));
  }

  async delete(id: string): Promise<{ runningInstanceIds: string[] }> {
    const runningRows = this.db.prepare(`
      SELECT instance_id
      FROM automation_runs
      WHERE automation_id = ?
        AND status = 'running'
        AND instance_id IS NOT NULL
    `).all<{ instance_id: string }>(id);
    this.db.prepare(`DELETE FROM automations WHERE id = ?`).run(id);
    return { runningInstanceIds: runningRows.map((row) => row.instance_id) };
  }

  decideAndInsertRun(
    automation: Automation | null,
    trigger: AutomationTrigger,
    fireTime: number,
    now = Date.now(),
  ): FireDecision {
    if (!automation) {
      return { kind: 'missing', reason: 'Automation no longer exists' };
    }

    const tx = this.db.transaction((): FireDecision => {
      const latest = this.getAutomationRow(automation.id);
      if (!latest) {
        return { kind: 'missing', reason: 'Automation no longer exists' };
      }
      const current = this.mapAutomationSync(latest);
      current.action = {
        ...current.action,
        attachments: automation.action.attachments,
      };

      if (!current.enabled || !current.active) {
        const run = this.insertRun(current, 'skipped', trigger, fireTime, now, {
          finishedAt: now,
          error: current.active ? 'Automation is disabled' : 'Automation is inactive',
        });
        this.advanceScheduleBaselineIfNeeded(current.id, run.id, trigger, fireTime);
        return { kind: 'skipped', reason: run.error ?? 'Automation skipped', run };
      }

      if (trigger !== 'manual' && current.lastFiredAt !== null && fireTime <= current.lastFiredAt) {
        return { kind: 'skipped', reason: 'Scheduled fire time was already processed' };
      }

      if (trigger !== 'manual' && this.findDedupeRun(current.id, fireTime)) {
        this.advanceScheduleBaselineIfNeeded(current.id, current.lastRunId, trigger, fireTime);
        return { kind: 'skipped', reason: 'Scheduled fire time already has a run' };
      }

      const running = this.db.prepare(`
        SELECT id
        FROM automation_runs
        WHERE automation_id = ?
          AND status IN ('running', 'pending')
        LIMIT 1
      `).get<{ id: string }>(current.id);

      if (running && current.concurrencyPolicy === 'skip') {
        const run = this.insertRun(current, 'skipped', trigger, fireTime, now, {
          finishedAt: now,
          error: 'Previous automation run is still active',
        });
        this.advanceScheduleBaselineIfNeeded(current.id, run.id, trigger, fireTime);
        return { kind: 'skipped', reason: run.error ?? 'Automation skipped', run };
      }

      if (running && current.concurrencyPolicy === 'queue') {
        const run = this.insertRun(current, 'pending', trigger, fireTime, now);
        this.advanceScheduleBaselineIfNeeded(current.id, run.id, trigger, fireTime);
        return { kind: 'queued', run };
      }

      const run = this.insertRun(current, 'running', trigger, fireTime, now, { startedAt: now });
      this.advanceScheduleBaselineIfNeeded(current.id, run.id, trigger, fireTime);
      return { kind: 'started', run };
    });

    return tx();
  }

  attachInstance(runId: string, instanceId: string, now = Date.now()): AutomationRun | null {
    this.db.prepare(`
      UPDATE automation_runs
      SET instance_id = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(instanceId, now, runId);
    return this.getRun(runId);
  }

  terminalizeRun(
    runId: string,
    status: Exclude<AutomationRunStatus, 'pending' | 'running'>,
    error?: string,
    outputSummary?: string,
    now = Date.now(),
  ): AutomationRun | null {
    const tx = this.db.transaction(() => {
      const row = this.getRunRow(runId);
      if (!row || !['pending', 'running'].includes(row.status)) {
        return row ? this.mapRun(row) : null;
      }

      this.db.prepare(`
        UPDATE automation_runs
        SET status = ?,
            finished_at = ?,
            error = ?,
            output_summary = ?,
            updated_at = ?
        WHERE id = ?
      `).run(status, now, error ?? null, outputSummary ?? null, now, runId);

      const automation = this.getAutomationRow(row.automation_id);
      if (automation?.schedule_type === 'oneTime') {
        const active = status === 'succeeded' ? 0 : automation.active;
        this.db.prepare(`
          UPDATE automations
          SET active = ?, next_fire_at = NULL, updated_at = ?
          WHERE id = ?
        `).run(active, now, row.automation_id);
      }

      return this.getRun(runId);
    });
    return tx();
  }

  claimNextPending(automationId?: string, now = Date.now()): ClaimedAutomationRun | null {
    const tx = this.db.transaction((): ClaimedAutomationRun | null => {
      const row = this.db.prepare(`
        SELECT *
        FROM automation_runs
        WHERE status = 'pending'
          ${automationId ? 'AND automation_id = ?' : ''}
        ORDER BY scheduled_at ASC, created_at ASC
        LIMIT 1
      `).get<AutomationRunRow>(...(automationId ? [automationId] : []));
      if (!row) {
        return null;
      }

      const automationRow = this.getAutomationRow(row.automation_id);
      if (!automationRow) {
        return null;
      }

      this.db.prepare(`
        UPDATE automation_runs
        SET status = 'running',
            started_at = ?,
            updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(now, now, row.id);

      const claimed = this.getRun(row.id);
      if (!claimed?.configSnapshot) {
        return null;
      }

      return {
        run: claimed,
        automation: this.mapAutomationSync(automationRow),
        snapshot: claimed.configSnapshot,
      };
    });
    return tx();
  }

  cancelPending(automationId: string, now = Date.now()): AutomationRun[] {
    const pending = this.db.prepare(`
      SELECT *
      FROM automation_runs
      WHERE automation_id = ? AND status = 'pending'
      ORDER BY scheduled_at ASC
    `).all<AutomationRunRow>(automationId);

    this.db.prepare(`
      UPDATE automation_runs
      SET status = 'cancelled',
          finished_at = ?,
          error = 'Pending automation run cancelled',
          updated_at = ?
      WHERE automation_id = ? AND status = 'pending'
    `).run(now, now, automationId);

    return pending.map((row) => ({
      ...this.mapRun(row),
      status: 'cancelled',
      finishedAt: now,
      error: 'Pending automation run cancelled',
      updatedAt: now,
    }));
  }

  recordSkipped(
    automation: Automation,
    trigger: AutomationTrigger,
    fireTime: number,
    reason: string,
    now = Date.now(),
  ): AutomationRun {
    const tx = this.db.transaction(() => {
      if (trigger !== 'manual' && this.findDedupeRun(automation.id, fireTime)) {
        this.advanceScheduleBaselineIfNeeded(automation.id, automation.lastRunId, trigger, fireTime);
        const existing = this.findDedupeRun(automation.id, fireTime);
        if (existing) {
          return this.mapRun(existing);
        }
      }
      const run = this.insertRun(automation, 'skipped', trigger, fireTime, now, {
        finishedAt: now,
        error: reason,
      });
      this.advanceScheduleBaselineIfNeeded(automation.id, run.id, trigger, fireTime);
      return run;
    });
    return tx();
  }

  listRuns(options: { automationId?: string; limit?: number } = {}): AutomationRun[] {
    const limit = options.limit ?? 100;
    const rows = options.automationId
      ? this.db.prepare(`
          SELECT *
          FROM automation_runs
          WHERE automation_id = ?
          ORDER BY scheduled_at DESC, created_at DESC
          LIMIT ?
        `).all<AutomationRunRow>(options.automationId, limit)
      : this.db.prepare(`
          SELECT *
          FROM automation_runs
          ORDER BY scheduled_at DESC, created_at DESC
          LIMIT ?
        `).all<AutomationRunRow>(limit);

    return rows.map((row) => this.mapRun(row));
  }

  getRun(runId: string): AutomationRun | null {
    const row = this.getRunRow(runId);
    return row ? this.mapRun(row) : null;
  }

  getRunByInstance(instanceId: string): AutomationRun | null {
    const row = this.db.prepare(`
      SELECT *
      FROM automation_runs
      WHERE instance_id = ? AND status = 'running'
      ORDER BY started_at DESC
      LIMIT 1
    `).get<AutomationRunRow>(instanceId);
    return row ? this.mapRun(row) : null;
  }

  markSeen(params: { automationId?: string; runId?: string }, now = Date.now()): void {
    if (params.runId) {
      this.db.prepare(`UPDATE automation_runs SET seen_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, params.runId);
      return;
    }
    if (params.automationId) {
      this.db.prepare(`
        UPDATE automation_runs
        SET seen_at = ?, updated_at = ?
        WHERE automation_id = ? AND seen_at IS NULL
      `).run(now, now, params.automationId);
    }
  }

  clearNextFireAt(automationId: string, now = Date.now()): void {
    this.db.prepare(`
      UPDATE automations
      SET next_fire_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, automationId);
  }

  completeOneTime(automationId: string, now = Date.now()): void {
    this.db.prepare(`
      UPDATE automations
      SET active = 0,
          next_fire_at = NULL,
          updated_at = ?
      WHERE id = ?
        AND schedule_type = 'oneTime'
    `).run(now, automationId);
  }

  setNextFireAt(automationId: string, nextFireAt: number | null, now = Date.now()): void {
    this.db.prepare(`
      UPDATE automations
      SET next_fire_at = ?, updated_at = ?
      WHERE id = ?
    `).run(nextFireAt, now, automationId);
  }

  failRunningRuns(reason: string, now = Date.now()): AutomationRun[] {
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT *
        FROM automation_runs
        WHERE status = 'running'
      `).all<AutomationRunRow>();

      this.db.prepare(`
        UPDATE automation_runs
        SET status = 'failed',
            finished_at = ?,
            error = ?,
            updated_at = ?
        WHERE status = 'running'
      `).run(now, reason, now);

      for (const row of rows) {
        const automation = this.getAutomationRow(row.automation_id);
        if (automation?.schedule_type === 'oneTime') {
          this.db.prepare(`
            UPDATE automations
            SET next_fire_at = NULL,
                updated_at = ?
            WHERE id = ?
          `).run(now, row.automation_id);
        }
      }

      return rows.map((row) => ({
        ...this.mapRun(row),
        status: 'failed' as const,
        finishedAt: now,
        error: reason,
        updatedAt: now,
      }));
    });
    return tx();
  }

  private insertRun(
    automation: Automation,
    status: AutomationRunStatus,
    trigger: AutomationTrigger,
    scheduledAt: number,
    now: number,
    extras: { startedAt?: number; finishedAt?: number; error?: string } = {},
  ): AutomationRun {
    const id = generateId();
    const snapshot = toSnapshot(automation);
    this.db.prepare(`
      INSERT INTO automation_runs
        (id, automation_id, status, trigger, scheduled_at, started_at, finished_at,
         instance_id, error, output_summary, seen_at, config_snapshot_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?)
    `).run(
      id,
      automation.id,
      status,
      trigger,
      scheduledAt,
      extras.startedAt ?? null,
      extras.finishedAt ?? null,
      extras.error ?? null,
      JSON.stringify(snapshot),
      now,
      now,
    );

    const run = this.getRun(id);
    if (!run) {
      throw new Error(`Automation run ${id} was not inserted`);
    }
    return run;
  }

  private advanceScheduleBaselineIfNeeded(
    automationId: string,
    runId: string | null | undefined,
    trigger: AutomationTrigger,
    fireTime: number,
  ): void {
    if (trigger === 'manual') {
      if (runId) {
        this.db.prepare(`UPDATE automations SET last_run_id = ? WHERE id = ?`).run(runId, automationId);
      }
      return;
    }
    this.db.prepare(`
      UPDATE automations
      SET last_fired_at = CASE
            WHEN last_fired_at IS NULL OR last_fired_at < ? THEN ?
            ELSE last_fired_at
          END,
          last_run_id = COALESCE(?, last_run_id)
      WHERE id = ?
    `).run(fireTime, fireTime, runId ?? null, automationId);
  }

  private findDedupeRun(automationId: string, scheduledAt: number): AutomationRunRow | undefined {
    return this.db.prepare(`
      SELECT *
      FROM automation_runs
      WHERE automation_id = ? AND scheduled_at = ? AND trigger IN ('scheduled', 'catchUp')
      LIMIT 1
    `).get<AutomationRunRow>(automationId, scheduledAt);
  }

  private getAutomationRow(id: string): AutomationRow | undefined {
    return this.db.prepare(`SELECT * FROM automations WHERE id = ?`).get<AutomationRow>(id);
  }

  private getRunRow(id: string): AutomationRunRow | undefined {
    return this.db.prepare(`SELECT * FROM automation_runs WHERE id = ?`).get<AutomationRunRow>(id);
  }

  private async mapAutomation(row: AutomationRow): Promise<Automation> {
    const automation = this.mapAutomationSync(row);
    automation.action = {
      ...automation.action,
      attachments: await this.attachmentService.listForAutomation(row.id),
    };
    return automation;
  }

  private mapAutomationSync(row: AutomationRow): Automation {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      enabled: row.enabled === 1,
      active: row.active === 1,
      schedule: JSON.parse(row.schedule_json) as AutomationSchedule,
      missedRunPolicy: row.missed_run_policy,
      concurrencyPolicy: row.concurrency_policy,
      action: JSON.parse(row.action_json) as AutomationAction,
      nextFireAt: row.next_fire_at,
      lastFiredAt: row.last_fired_at,
      lastRunId: row.last_run_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      unreadRunCount: row.unread_run_count ?? 0,
    };
  }

  private mapRun(row: AutomationRunRow): AutomationRun {
    return {
      id: row.id,
      automationId: row.automation_id,
      status: row.status,
      trigger: row.trigger,
      scheduledAt: row.scheduled_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      instanceId: row.instance_id,
      error: row.error,
      outputSummary: row.output_summary,
      seenAt: row.seen_at,
      configSnapshot: row.config_snapshot_json
        ? JSON.parse(row.config_snapshot_json) as AutomationConfigSnapshot
        : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
