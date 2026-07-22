import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../rlm-schema';

const MIGRATION_NAME = '052_dedupe_identical_automations';

const dbs: SqliteDriver[] = [];

/**
 * Open a fully migrated database and roll the dedupe migration back to
 * "pending" so a test can seed the duplicates it is meant to consolidate and
 * then re-run it through the real migration runner (wiring included).
 */
function openDbBeforeDedupe(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  db.prepare(`DELETE FROM _migrations WHERE name = ?`).run(MIGRATION_NAME);
  return db;
}

interface SeedAutomation {
  id: string;
  name?: string;
  enabled?: number;
  active?: number;
  workspaceId?: string;
  scheduleType?: string;
  scheduleJson?: string;
  triggerJson?: string;
  actionJson?: string;
  nextFireAt?: number | null;
  lastFiredAt?: number | null;
  createdAt?: number;
}

const CRON_SCHEDULE = JSON.stringify({ type: 'cron', expression: '0 * * * *', timezone: 'Europe/London' });
const HOURLY_ACTION = JSON.stringify({ workingDirectory: '/tmp/realer', provider: 'claude', prompt: 'Check the server' });

function seedAutomation(db: SqliteDriver, automation: SeedAutomation): void {
  db.prepare(`
    INSERT INTO automations
      (id, name, description, enabled, active, workspace_id, schedule_type, schedule_json, trigger_json,
       missed_run_policy, concurrency_policy, action_json, next_fire_at, last_fired_at, last_run_id,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'notify', 'skip', ?, ?, ?, NULL, ?, ?)
  `).run(
    automation.id,
    automation.name ?? `automation ${automation.id}`,
    `description ${automation.id}`,
    automation.enabled ?? 1,
    automation.active ?? 1,
    automation.workspaceId ?? '/tmp/realer',
    automation.scheduleType ?? 'cron',
    automation.scheduleJson ?? CRON_SCHEDULE,
    automation.triggerJson ?? '{"kind":"schedule"}',
    automation.actionJson ?? HOURLY_ACTION,
    automation.nextFireAt === undefined ? 5_000 : automation.nextFireAt,
    automation.lastFiredAt === undefined ? null : automation.lastFiredAt,
    automation.createdAt ?? 1_000,
    automation.createdAt ?? 1_000,
  );
}

function seedRun(
  db: SqliteDriver,
  run: {
    id: string;
    automationId: string;
    scheduledAt: number;
    status?: string;
    trigger?: string;
    idempotencyKey?: string | null;
    createdAt?: number;
  },
): void {
  db.prepare(`
    INSERT INTO automation_runs
      (id, automation_id, status, trigger, scheduled_at, idempotency_key, delivery_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'notify', ?, ?)
  `).run(
    run.id,
    run.automationId,
    run.status ?? 'succeeded',
    run.trigger ?? 'scheduled',
    run.scheduledAt,
    run.idempotencyKey ?? null,
    run.createdAt ?? 1,
    run.createdAt ?? 1,
  );
}

function automationIds(db: SqliteDriver): string[] {
  return db.prepare(`SELECT id FROM automations ORDER BY id`).all<{ id: string }>().map((row) => row.id);
}

function runIds(db: SqliteDriver, automationId: string): string[] {
  return db
    .prepare(`SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY id`)
    .all<{ id: string }>(automationId)
    .map((row) => row.id);
}

describe('052_dedupe_identical_automations', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) {
      db.close();
    }
  });

  it('collapses byte-identical automations onto the earliest-created keeper', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, { id: 'a-keeper', name: 'Realer hourly server check', createdAt: 100 });
    seedAutomation(db, { id: 'b-dup', name: 'Realer Minecraft hourly server…', createdAt: 200 });
    seedAutomation(db, { id: 'c-dup', name: 'Realer Minecraft Server Hourly', createdAt: 300 });

    runMigrations(db);

    expect(automationIds(db)).toEqual(['a-keeper']);
    expect(db.prepare(`SELECT name FROM automations`).get<{ name: string }>()?.name)
      .toBe('Realer hourly server check');
  });

  it('repoints loser runs onto the keeper and orphans none', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, { id: 'a-keeper', createdAt: 100 });
    seedAutomation(db, { id: 'b-dup', createdAt: 200 });
    seedRun(db, { id: 'r-keeper-1', automationId: 'a-keeper', scheduledAt: 1_000 });
    seedRun(db, { id: 'r-dup-2', automationId: 'b-dup', scheduledAt: 2_000 });
    seedRun(db, { id: 'r-dup-3', automationId: 'b-dup', scheduledAt: 3_000 });

    runMigrations(db);

    expect(runIds(db, 'a-keeper')).toEqual(['r-dup-2', 'r-dup-3', 'r-keeper-1']);
    const orphans = db.prepare(`
      SELECT count(*) AS n FROM automation_runs r
      WHERE NOT EXISTS (SELECT 1 FROM automations a WHERE a.id = r.automation_id)
    `).get<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });

  it('drops a loser run whose tick the keeper already occupies', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, { id: 'a-keeper', createdAt: 100 });
    seedAutomation(db, { id: 'b-dup', createdAt: 200 });
    seedRun(db, { id: 'r-keeper', automationId: 'a-keeper', scheduledAt: 1_000 });
    seedRun(db, { id: 'r-dup-same-tick', automationId: 'b-dup', scheduledAt: 1_000 });
    seedRun(db, { id: 'r-dup-own-tick', automationId: 'b-dup', scheduledAt: 2_000 });

    runMigrations(db);

    expect(runIds(db, 'a-keeper')).toEqual(['r-dup-own-tick', 'r-keeper']);
  });

  it('keeps the most informative loser run when the keeper has no run at that tick', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, { id: 'a-keeper', createdAt: 100 });
    seedAutomation(db, { id: 'b-dup', createdAt: 200 });
    seedAutomation(db, { id: 'c-dup', createdAt: 300 });
    seedRun(db, { id: 'r-ok', automationId: 'b-dup', scheduledAt: 1_000, status: 'succeeded' });
    seedRun(db, { id: 'r-failed', automationId: 'c-dup', scheduledAt: 1_000, status: 'failed' });

    runMigrations(db);

    expect(runIds(db, 'a-keeper')).toEqual(['r-failed']);
  });

  it('drops loser runs that would collide on the external idempotency key', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, { id: 'a-keeper', createdAt: 100 });
    seedAutomation(db, { id: 'b-dup', createdAt: 200 });
    seedRun(db, {
      id: 'r-keeper',
      automationId: 'a-keeper',
      scheduledAt: 1_000,
      trigger: 'manual',
      idempotencyKey: 'shared-key',
    });
    seedRun(db, {
      id: 'r-dup',
      automationId: 'b-dup',
      scheduledAt: 2_000,
      trigger: 'manual',
      idempotencyKey: 'shared-key',
    });

    runMigrations(db);

    expect(runIds(db, 'a-keeper')).toEqual(['r-keeper']);
  });

  it('folds enabled, last_fired_at and a missing next_fire_at into the keeper', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, {
      id: 'a-keeper',
      createdAt: 100,
      enabled: 0,
      nextFireAt: null,
      lastFiredAt: 500,
    });
    seedAutomation(db, {
      id: 'b-dup',
      createdAt: 200,
      enabled: 1,
      nextFireAt: 9_000,
      lastFiredAt: 800,
    });
    seedAutomation(db, {
      id: 'c-dup',
      createdAt: 300,
      enabled: 0,
      nextFireAt: 7_000,
      lastFiredAt: null,
    });

    runMigrations(db);

    const keeper = db.prepare(`
      SELECT enabled, next_fire_at, last_fired_at FROM automations WHERE id = 'a-keeper'
    `).get<{ enabled: number; next_fire_at: number | null; last_fired_at: number | null }>();
    expect(keeper).toEqual({ enabled: 1, next_fire_at: 9_000, last_fired_at: 800 });
  });

  it('leaves last_fired_at null when no member of the group ever fired', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, { id: 'a-keeper', createdAt: 100, lastFiredAt: null });
    seedAutomation(db, { id: 'b-dup', createdAt: 200, lastFiredAt: null });

    runMigrations(db);

    expect(db.prepare(`SELECT last_fired_at FROM automations`).get<{ last_fired_at: number | null }>())
      .toEqual({ last_fired_at: null });
  });

  it('leaves genuinely distinct automations untouched', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, { id: 'a-base', createdAt: 100 });
    seedAutomation(db, {
      id: 'b-other-prompt',
      createdAt: 200,
      actionJson: JSON.stringify({
        workingDirectory: '/tmp/realer',
        provider: 'claude',
        prompt: 'Check the database',
      }),
    });
    seedAutomation(db, {
      id: 'c-other-provider',
      createdAt: 300,
      actionJson: JSON.stringify({
        workingDirectory: '/tmp/realer',
        provider: 'codex',
        prompt: 'Check the server',
      }),
    });
    seedAutomation(db, { id: 'd-other-workspace', createdAt: 400, workspaceId: '/tmp/other' });
    seedAutomation(db, {
      id: 'e-other-schedule',
      createdAt: 500,
      scheduleJson: JSON.stringify({ type: 'cron', expression: '*/5 * * * *', timezone: 'Europe/London' }),
    });
    seedAutomation(db, {
      id: 'f-other-system-action',
      createdAt: 600,
      actionJson: JSON.stringify({
        workingDirectory: '/tmp/realer',
        provider: 'claude',
        prompt: 'Check the server',
        systemAction: { type: 'loopProviderLimitResume', loopRunId: 'loop-1' },
      }),
    });

    runMigrations(db);

    expect(automationIds(db)).toEqual([
      'a-base',
      'b-other-prompt',
      'c-other-provider',
      'd-other-workspace',
      'e-other-schedule',
      'f-other-system-action',
    ]);
  });

  it('skips inactive and non-schedule automations', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, { id: 'a-keeper', createdAt: 100 });
    seedAutomation(db, { id: 'b-inactive', createdAt: 200, active: 0 });
    seedAutomation(db, { id: 'c-webhook', createdAt: 300, triggerJson: '{"kind":"webhook"}' });
    seedAutomation(db, { id: 'd-webhook', createdAt: 400, triggerJson: '{"kind":"webhook"}' });

    runMigrations(db);

    expect(automationIds(db)).toEqual(['a-keeper', 'b-inactive', 'c-webhook', 'd-webhook']);
  });

  it('skips automations carrying attachments', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, { id: 'a-keeper', createdAt: 100 });
    seedAutomation(db, { id: 'b-dup', createdAt: 200 });
    db.prepare(`
      INSERT INTO automation_attachments
        (id, automation_id, position, name, type, size, content_ref_json, created_at)
      VALUES ('att-1', 'b-dup', 0, 'plan.md', 'text/markdown', 12, '{"inline":true,"content":"hello"}', 1)
    `).run();

    runMigrations(db);

    expect(automationIds(db)).toEqual(['a-keeper', 'b-dup']);
  });

  it('skips automations with an in-flight run', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, { id: 'a-keeper', createdAt: 100 });
    seedAutomation(db, { id: 'b-dup', createdAt: 200 });
    seedRun(db, { id: 'r-live', automationId: 'b-dup', scheduledAt: 1_000, status: 'running' });

    runMigrations(db);

    expect(automationIds(db)).toEqual(['a-keeper', 'b-dup']);
  });

  it('skips automations referenced by a webhook route allowlist', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, { id: 'a-keeper', createdAt: 100 });
    seedAutomation(db, { id: 'b-dup', createdAt: 200 });
    db.prepare(`
      INSERT INTO webhook_routes
        (id, path, secret_hash, allowed_automation_ids_json, allowed_events_json, created_at, updated_at)
      VALUES ('route-1', '/hooks/one', 'placeholder-hash', '["b-dup"]', '[]', 1, 1)
    `).run();

    runMigrations(db);

    expect(automationIds(db)).toEqual(['a-keeper', 'b-dup']);
  });

  it('drops the losers thread destination and keeps the keepers', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, { id: 'a-keeper', createdAt: 100 });
    seedAutomation(db, { id: 'b-dup', createdAt: 200 });
    db.prepare(`
      INSERT INTO automation_thread_destinations (automation_id, instance_id, revive_if_archived)
      VALUES ('a-keeper', 'instance-keeper', 1), ('b-dup', 'instance-dup', 1)
    `).run();

    runMigrations(db);

    expect(db.prepare(`SELECT automation_id, instance_id FROM automation_thread_destinations`).all())
      .toEqual([{ automation_id: 'a-keeper', instance_id: 'instance-keeper' }]);
  });

  it('is a no-op on a database with no duplicates', () => {
    const db = openDbBeforeDedupe();
    seedAutomation(db, { id: 'a-only', createdAt: 100 });
    seedRun(db, { id: 'r-1', automationId: 'a-only', scheduledAt: 1_000 });

    runMigrations(db);

    expect(automationIds(db)).toEqual(['a-only']);
    expect(runIds(db, 'a-only')).toEqual(['r-1']);
  });
});
