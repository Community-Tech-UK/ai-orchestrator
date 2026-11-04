import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import { CatchUpCoordinator } from './catch-up-coordinator';
import type { AutomationRunner } from './automation-runner';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/monitor-catchup-test' } }));

describe('catch-up respects deliberately slowed monitor checks', () => {
  let db: ReturnType<typeof defaultDriverFactory>;
  let store: AutomationStore;
  beforeEach(() => {
    resetAutomationEventsForTesting();
    db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined, listForAutomation: async () => [] } as never);
  });
  afterEach(() => { resetAutomationEventsForTesting(); db.close(); });

  it.each([
    ['startup', 'runOnce'], ['startup', 'notify'], ['resume', 'runOnce'], ['resume', 'notify'],
  ] as const)('ignores skipped cron occurrences during %s with %s', async (sweep, policy) => {
    const at = Date.parse('2026-11-03T10:00:00Z');
    const job = await store.create({ name: 'Slower monitor', schedule: { type: 'cron', expression: '*/10 * * * *', timezone: 'UTC' },
      missedRunPolicy: policy, action: { prompt: 'Check', workingDirectory: '/fixture', slowWhenUnchanged: true } }, at + 600_000, at - 1000);
    for (let i = 0; i < 3; i++) {
      const decision = store.decideAndInsertRun(job, 'scheduled', at + i, at + i);
      if (decision.kind !== 'started') throw new Error('Expected monitor check');
      store.terminalizeRun(decision.run.id, 'succeeded', undefined, 'Healthy', at + i);
    }
    expect(await store.get(job.id)).toMatchObject({ nextFireAt: at + 2_400_000, monitorState: { intervalMultiplier: 4 } });
    const fire = vi.fn().mockResolvedValue({ status: 'started' });
    const changed = vi.spyOn(getAutomationEvents(), 'emitRunChanged');
    const coordinator = new CatchUpCoordinator(store, { fire } as unknown as AutomationRunner);
    const runSweep = (until: number) => sweep === 'startup' ? coordinator.runStartupSweep(until)
      : coordinator.runResumeSweep({ suspendedAt: at, resumedAt: until });
    await runSweep(at + 1_800_001);
    expect(fire).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(store.listRuns({ automationId: job.id })).toHaveLength(3);
    // Croner's history excludes the current second; check after that second.
    await runSweep(at + 2_401_000);
    if (policy === 'runOnce') expect(fire).toHaveBeenCalledExactlyOnceWith(job.id, { trigger: 'catchUp', scheduledAt: at + 2_400_000 });
    else expect(store.listRuns({ automationId: job.id }).filter(run => run.trigger === 'catchUp').map(run => run.scheduledAt)).toEqual([at + 2_400_000]);
  });
});
