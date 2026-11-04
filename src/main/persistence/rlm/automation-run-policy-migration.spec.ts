import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import { createTables, MIGRATIONS, AUTOMATION_RUN_POLICY_MIGRATION } from './rlm-schema';

const databases: ReturnType<typeof defaultDriverFactory>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

describe('scheduled job migration', () => {
  it('uses the longest success, a thirty-minute floor and schedule-specific token defaults without overwriting configured limits', () => {
    const db = defaultDriverFactory(':memory:'); databases.push(db); createTables(db);
    for (const migration of MIGRATIONS) if (migration.name !== AUTOMATION_RUN_POLICY_MIGRATION.name) db.exec(migration.up);
    for (const [id, type, action] of [['short', 'cron', {}], ['long', 'oneTime', {}], ['custom', 'cron', { maxRunMinutes: 42, maxProcessedTokens: 123 }]] as const) {
      db.prepare(`INSERT INTO automations(id, name, schedule_type, schedule_json, missed_run_policy, concurrency_policy, action_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'skip', 'skip', ?, 1, 1)`).run(id, id, type, JSON.stringify({ type }), JSON.stringify({ prompt: 'Example', workingDirectory: '/repo', ...action }));
    }
    for (const [id, job, status, minutes] of [['run-1', 'short', 'succeeded', 10], ['run-2', 'long', 'succeeded', 40], ['run-3', 'long', 'succeeded', 20], ['run-4', 'long', 'failed', 500]] as const) {
      db.prepare(`INSERT INTO automation_runs(id, automation_id, status, trigger, scheduled_at, started_at, finished_at, created_at, updated_at)
        VALUES (?, ?, ?, 'manual', 0, 0, ?, 1, 1)`).run(id, job, status, minutes * 60000);
    }
    db.exec(AUTOMATION_RUN_POLICY_MIGRATION.up);
    const actions = Object.fromEntries(db.prepare('SELECT id, action_json FROM automations').all<{ id: string; action_json: string }>().map(row => [row.id, JSON.parse(row.action_json)]));
    expect(actions['short']).toMatchObject({ maxRunMinutes: 30, maxProcessedTokens: 30_000_000 });
    expect(actions['long']).toMatchObject({ maxRunMinutes: 60, maxProcessedTokens: 100_000_000 });
    expect(actions['custom']).toMatchObject({ maxRunMinutes: 42, maxProcessedTokens: 123 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM automation_runs').get()).toEqual({ n: 4 });
  });
});
