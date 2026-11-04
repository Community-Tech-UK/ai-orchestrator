import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createTables, createMigrationsTable, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import { AutomationLoopRunDispatcher, automationLoopChatId } from './automation-loop-run';
import { automationInvocations } from './automation-invocation-context';

const output = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => output.dir } }));
vi.mock('../session/artifact-attribution-store', () => ({ getArtifactAttributionStore: () => ({ registerArtifact: () => undefined }) }));

describe('complete loop monitor comparison through the dispatcher and store', () => {
  let db: ReturnType<typeof defaultDriverFactory>;
  let store: AutomationStore;
  let dispatcher: AutomationLoopRunDispatcher;
  const clock = Date.UTC(2026, 10, 2, 12);
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(clock);
    output.dir = mkdtempSync(join(process.cwd(), '_scratch', 'loop-monitor-'));
    db = defaultDriverFactory(':memory:');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined,
      listForAutomation: async () => [] } as never);
    dispatcher = new AutomationLoopRunDispatcher({ store, now: () => clock, onTerminal: () => undefined,
      subscribeLoopStateChanged: () => undefined });
  });
  afterEach(() => {
    automationInvocations.reset(); vi.clearAllTimers(); vi.useRealTimers(); db.close();
    rmSync(output.dir, { recursive: true, force: true });
  });

  it('resets backoff on an earlier warning while keeping the final signoff as the summary', async () => {
    const job = await store.create({ name: 'Check', schedule: { type: 'cron', expression: '*/10 * * * *', timezone: 'UTC' },
      action: { prompt: 'Check', workingDirectory: '/fixture', slowWhenUnchanged: true,
        loop: { verifyCommand: 'example-command' } } }, clock + 600_000, clock);
    for (const [i, finding] of ['Healthy', 'Healthy', 'Urgent warning'].entries()) {
      const decision = store.decideAndInsertRun(job, 'manual', clock, clock);
      if (decision.kind !== 'started') throw new Error('Expected a started run');
      const loopId = `loop-${i}`;
      store.attachLoopRun(decision.run.id, loopId, clock);
      dispatcher.track(loopId, decision.run);
      for (const [seq, content] of [finding, 'Finished checking.'].entries()) {
        dispatcher.observeProviderEvent({ eventId: `${loopId}-${seq}`, seq, timestamp: clock,
          instanceId: automationLoopChatId(job.id, decision.run.id), provider: 'claude', adapterGeneration: 1,
          event: { kind: 'output', messageType: 'assistant', content } });
      }
      dispatcher.observeProviderEvent({ eventId: `${loopId}-tool`, seq: 2, timestamp: clock,
        instanceId: automationLoopChatId(job.id, decision.run.id), provider: 'claude', adapterGeneration: 1,
        event: { kind: 'output', messageType: 'tool', content: `Changing diagnostic ${i}` } });
      dispatcher.handleLoopStateChanged({ loopRunId: loopId, state: { status: 'completed' } });
      expect(store.getRun(decision.run.id)).toMatchObject({ status: 'succeeded', outputSummary: 'Finished checking.' });
      expect(await store.get(job.id)).toMatchObject({ monitorState: {
        unchangedChecks: i === 1 ? 2 : 1, intervalMultiplier: i === 1 ? 2 : 1,
      } });
    }
  });
});
