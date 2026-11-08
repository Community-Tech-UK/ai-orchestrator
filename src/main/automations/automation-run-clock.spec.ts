import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import { automationRunDeadline } from './automation-run-clock';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/automation-clock-test' }, powerMonitor: new EventEmitter() }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));

const NOW = Date.UTC(2026, 9, 28, 12);
let db: ReturnType<typeof defaultDriverFactory>;
let store: AutomationStore;
beforeEach(() => {
  db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
  store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined, listForAutomation: async () => [] } as never);
});
afterEach(() => { db.close(); });

async function runningRun() {
  const automation = await store.create({ name: 'Work', schedule: { type: 'oneTime', runAt: NOW },
    action: { prompt: 'Original work', workingDirectory: '/synthetic', maxRunMinutes: 1 } }, NOW, NOW);
  const claimed = store.decideAndInsertRun(automation, 'manual', NOW, NOW);
  if (claimed.kind !== 'started') throw new Error('Run fixture did not start');
  return claimed.run;
}

describe('durable automation run clock', () => {
  it('does not count time paused for a restart against the run time limit', async () => {
    const run = await runningRun();
    expect(automationRunDeadline(store.getRun(run.id)!, 1, NOW)).toBe(NOW + 60_000);
    store.setRunPaused(run.id, true, NOW + 20_000);
    // While paused the deadline keeps moving out with the clock.
    expect(automationRunDeadline(store.getRun(run.id)!, 1, NOW + 100_000)).toBe(NOW + 140_000);
    store.setRunPaused(run.id, false, NOW + 140_000);
    expect(automationRunDeadline(store.getRun(run.id)!, 1, NOW + 150_000)).toBe(NOW + 180_000);
    expect(store.getRun(run.id)!.startedAt).toBe(NOW);
  });

  it('ignores repeated pause and resume notifications and a second pause adds to the first', async () => {
    const run = await runningRun();
    store.setRunPaused(run.id, true, NOW + 20_000);
    store.setRunPaused(run.id, true, NOW + 30_000);
    store.setRunPaused(run.id, false, NOW + 40_000);
    store.setRunPaused(run.id, false, NOW + 50_000);
    expect(automationRunDeadline(store.getRun(run.id)!, 1, NOW + 60_000)).toBe(NOW + 80_000);
    store.setRunPaused(run.id, true, NOW + 60_000);
    store.setRunPaused(run.id, false, NOW + 70_000);
    expect(automationRunDeadline(store.getRun(run.id)!, 1, NOW + 70_000)).toBe(NOW + 90_000);
  });

  it('leaves a finished run alone', async () => {
    const run = await runningRun();
    store.terminalizeRun(run.id, 'succeeded', undefined, undefined, NOW + 5_000);
    store.setRunPaused(run.id, true, NOW + 10_000);
    expect(automationRunDeadline(store.getRun(run.id)!, 1, NOW + 100_000)).toBe(NOW + 60_000);
  });
});
