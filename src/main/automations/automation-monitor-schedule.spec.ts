import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createTables, createMigrationsTable, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import type { AutomationSchedule } from '../../shared/types/automation.types';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));

describe('monitor calendar scheduling through the real store', () => {
  let db: ReturnType<typeof defaultDriverFactory>;
  let store: AutomationStore;
  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined,
      listForAutomation: async () => [] } as never);
  });
  afterEach(() => db.close());

  it.each([
    { label: 'daily', schedule: { expression: '0 9 * * *', timezone: 'UTC' }, now: '2026-11-02T09:10:00Z', expected: '2026-11-03T09:00:00Z' },
    { label: 'DST transition', schedule: { expression: '0 9 * * *', timezone: 'Europe/London' }, now: '2026-10-24T08:10:00Z', expected: '2026-10-25T09:00:00Z' },
  ])('returns a changed $label monitor to its next nominal occurrence', async ({ schedule, now, expected }) => {
    const clock = Date.parse(now);
    const job = await store.create({ name: 'Check', schedule: { type: 'cron', ...schedule },
      action: { prompt: 'Check', workingDirectory: '/fixture', slowWhenUnchanged: true } }, clock, clock);
    for (const text of ['Healthy', 'Healthy', 'Warning']) {
      const decision = store.decideAndInsertRun(job, 'manual', clock, clock);
      if (decision.kind !== 'started') throw new Error('Expected a started run');
      store.terminalizeRun(decision.run.id, 'succeeded', undefined, text, clock);
    }
    expect(await store.get(job.id)).toMatchObject({ nextFireAt: Date.parse(expected),
      monitorState: { intervalMultiplier: 1, unchangedChecks: 1 } });
  });

  it.each([
    { expression: '0 9 * * 1,5', now: '2026-11-02T09:10:00Z', expected: '2026-11-09T09:00:00Z' },
    { expression: '0 9 1 * *', now: '2026-11-02T09:10:00Z', expected: '2027-01-01T09:00:00Z' },
  ])('backs off by actual occurrences for $expression', async ({ expression, now, expected }) => {
    const clock = Date.parse(now);
    const schedule: AutomationSchedule = { type: 'cron', expression, timezone: 'UTC' };
    const job = await store.create({ name: 'Check', schedule,
      action: { prompt: 'Check', workingDirectory: '/fixture', slowWhenUnchanged: true } }, clock, clock);
    for (let i = 0; i < 2; i++) {
      const decision = store.decideAndInsertRun(job, 'manual', clock, clock);
      if (decision.kind !== 'started') throw new Error('Expected a started run');
      store.terminalizeRun(decision.run.id, 'succeeded', undefined, 'Healthy', clock);
    }
    expect(await store.get(job.id)).toMatchObject({ nextFireAt: Date.parse(expected),
      monitorState: { intervalMultiplier: 2, unchangedChecks: 2 } });
  });
});
