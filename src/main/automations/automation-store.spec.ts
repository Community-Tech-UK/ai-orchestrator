import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import type { AutomationAttachmentService } from './automation-attachment-service';
import type { FileAttachment } from '../../shared/types/instance.types';

function createDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.pragma('foreign_keys = ON');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

function fakeAttachmentService(attachments: FileAttachment[] = []): AutomationAttachmentService {
  return {
    prepare: async () => [],
    replacePrepared: () => undefined,
    listForAutomation: async () => attachments,
  } as unknown as AutomationAttachmentService;
}

describe('AutomationStore', () => {
  let db: SqliteDriver;
  let store: AutomationStore;
  const attachment: FileAttachment = {
    name: 'brief.txt',
    type: 'text/plain',
    size: 24,
    data: 'data:text/plain;base64,YnJpZWY=',
  };

  beforeEach(() => {
    db = createDb();
    store = new AutomationStore(db, fakeAttachmentService([attachment]));
  });

  afterEach(() => {
    db.close();
  });

  it('keeps scheduled baseline separate from manual runs', async () => {
    const automation = await store.create({
      name: 'Daily check',
      schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      action: {
        prompt: 'Check status',
        workingDirectory: '/tmp',
        attachments: [attachment],
      },
    }, 1_000, 100);

    const manual = store.decideAndInsertRun(automation, 'manual', 2_000, 2_000);
    expect(manual.kind).toBe('started');

    const afterManual = await store.get(automation.id);
    expect(afterManual?.lastFiredAt).toBeNull();
    expect(afterManual?.lastRunId).toBe(manual.run.id);

    const scheduled = store.decideAndInsertRun(afterManual, 'scheduled', 3_000, 3_000);
    expect(scheduled.kind).toBe('skipped');
    expect(scheduled.reason).toBe('Previous automation run is still active');

    const afterScheduled = await store.get(automation.id);
    expect(afterScheduled?.lastFiredAt).toBe(3_000);
    expect(afterScheduled?.lastRunId).toBe(scheduled.run?.id);
  });

  it('stores queued run snapshots and dispatches the claimed pending run', async () => {
    const automation = await store.create({
      name: 'Queued check',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'queue',
      action: {
        prompt: 'Original prompt',
        workingDirectory: '/tmp/original',
        attachments: [attachment],
      },
    }, 1_000, 100);

    const first = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000);
    expect(first.kind).toBe('started');

    const queued = store.decideAndInsertRun(automation, 'scheduled', 2_000, 2_000);
    expect(queued.kind).toBe('queued');
    expect(queued.run.configSnapshot?.action.prompt).toBe('Original prompt');
    expect(queued.run.configSnapshot?.action.attachments?.[0]?.name).toBe('brief.txt');

    await store.update(automation.id, {
      action: {
        prompt: 'Edited prompt',
        workingDirectory: '/tmp/edited',
        attachments: [],
      },
    }, 5_000, 2_500);

    store.terminalizeRun(first.run.id, 'succeeded', undefined, 'done', 3_000);
    const claimed = store.claimNextPending(automation.id, 3_100);

    expect(claimed?.run.status).toBe('running');
    expect(claimed?.snapshot.action.prompt).toBe('Original prompt');
    expect(claimed?.snapshot.action.workingDirectory).toBe('/tmp/original');
    expect(claimed?.snapshot.action.attachments?.[0]?.data).toBe(attachment.data);
  });

  it('does not insert a skipped row when the automation is missing', () => {
    const outcome = store.decideAndInsertRun(null, 'scheduled', 1_000, 1_000);
    expect(outcome.kind).toBe('missing');
    expect(store.listRuns()).toEqual([]);
  });

  it('clears one-time schedule state on failure without deactivating the automation', async () => {
    const automation = await store.create({
      name: 'One-time check',
      schedule: { type: 'oneTime', runAt: 1_000, timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      action: {
        prompt: 'Run once',
        workingDirectory: '/tmp',
      },
    }, 1_000, 100);

    const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000);
    expect(decision.kind).toBe('started');

    store.terminalizeRun(decision.run.id, 'failed', 'adapter failed', undefined, 2_000);

    const afterFailure = await store.get(automation.id);
    expect(afterFailure?.active).toBe(true);
    expect(afterFailure?.nextFireAt).toBeNull();
  });

  it('completes one-time automations skipped by missed-run policy', async () => {
    const automation = await store.create({
      name: 'Past one-time check',
      schedule: { type: 'oneTime', runAt: 1_000, timezone: 'UTC' },
      missedRunPolicy: 'skip',
      concurrencyPolicy: 'skip',
      action: {
        prompt: 'Run once',
        workingDirectory: '/tmp',
      },
    }, null, 2_000);

    const skipped = store.recordSkipped(automation, 'catchUp', 1_000, 'missed', 2_000);
    store.completeOneTime(automation.id, 2_000);

    const afterSkip = await store.get(automation.id);
    expect(skipped.status).toBe('skipped');
    expect(afterSkip?.active).toBe(false);
    expect(afterSkip?.nextFireAt).toBeNull();
  });

  it('fails running one-time runs on startup without re-arming stale next fire time', async () => {
    const automation = await store.create({
      name: 'Restarted one-time check',
      schedule: { type: 'oneTime', runAt: 1_000, timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      action: {
        prompt: 'Run once',
        workingDirectory: '/tmp',
      },
    }, 1_000, 100);

    const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000);
    expect(decision.kind).toBe('started');

    const failed = store.failRunningRuns('App restarted', 2_000);
    const afterRestart = await store.get(automation.id);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.status).toBe('failed');
    expect(afterRestart?.active).toBe(true);
    expect(afterRestart?.nextFireAt).toBeNull();
  });
});
