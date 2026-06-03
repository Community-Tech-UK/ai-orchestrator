import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from '../persistence/rlm/rlm-schema';
import { AutomationStore, DEFAULT_MAX_CONSECUTIVE_FAILURES } from './automation-store';
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

  it('defaults automations to new-instance delivery when no destination is supplied', async () => {
    const automation = await store.create({
      name: 'Default destination check',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      action: {
        prompt: 'Run elsewhere',
        workingDirectory: '/tmp',
      },
    }, 1_000, 100);

    const hydrated = await store.get(automation.id);

    expect(automation.destination).toEqual({ kind: 'newInstance' });
    expect(hydrated?.destination).toEqual({ kind: 'newInstance' });
  });

  it('persists thread destinations and includes them in queued run snapshots', async () => {
    const automation = await store.create({
      name: 'Thread destination check',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'queue',
      destination: {
        kind: 'thread',
        instanceId: 'instance-1',
        sessionId: 'session-1',
        historyEntryId: 'history-1',
        reviveIfArchived: true,
      },
      action: {
        prompt: 'Wake the thread',
        workingDirectory: '/tmp',
      },
    }, 1_000, 100);

    const hydrated = await store.get(automation.id);
    const first = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000);
    const queued = store.decideAndInsertRun(automation, 'scheduled', 2_000, 2_000);

    expect(hydrated?.destination).toEqual({
      kind: 'thread',
      instanceId: 'instance-1',
      sessionId: 'session-1',
      historyEntryId: 'history-1',
      reviveIfArchived: true,
    });
    expect(first.kind).toBe('started');
    expect(queued.kind).toBe('queued');
    expect(queued.run.configSnapshot?.destination).toEqual(hydrated?.destination);
  });

  it('removes companion thread destination rows when updated back to a new instance', async () => {
    const automation = await store.create({
      name: 'Destination update check',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      destination: {
        kind: 'thread',
        instanceId: 'instance-1',
        reviveIfArchived: false,
      },
      action: {
        prompt: 'Wake the thread',
        workingDirectory: '/tmp',
      },
    }, 1_000, 100);

    await store.update(automation.id, {
      destination: { kind: 'newInstance' },
    }, 2_000, 1_500);

    const hydrated = await store.get(automation.id);
    const companionRows = db
      .prepare('SELECT * FROM automation_thread_destinations WHERE automation_id = ?')
      .all(automation.id);

    expect(hydrated?.destination).toEqual({ kind: 'newInstance' });
    expect(companionRows).toEqual([]);
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

  it('deduplicates external trigger runs by idempotency key', async () => {
    const automation = await store.create({
      name: 'Webhook check',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'queue',
      action: {
        prompt: 'Handle webhook',
        workingDirectory: '/tmp',
      },
    }, 1_000, 100);

    const first = store.decideAndInsertRun(automation, 'webhook', 2_000, 2_000, {
      idempotencyKey: 'delivery-1',
      triggerSource: { type: 'webhook', id: 'route-1', deliveryId: 'delivery-1' },
      deliveryMode: 'localOnly',
    });
    expect(first.kind).toBe('started');

    const duplicate = store.decideAndInsertRun(automation, 'webhook', 3_000, 3_000, {
      idempotencyKey: 'delivery-1',
      triggerSource: { type: 'webhook', id: 'route-1', deliveryId: 'delivery-1' },
    });
    expect(duplicate.kind).toBe('skipped');
    expect(duplicate.run?.id).toBe(first.run.id);
    expect(duplicate.run?.triggerSource?.deliveryId).toBe('delivery-1');
    expect(duplicate.run?.deliveryMode).toBe('localOnly');
  });

  it('persists full output references when terminalizing runs', async () => {
    const automation = await store.create({
      name: 'Output check',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      action: {
        prompt: 'Write output',
        workingDirectory: '/tmp',
      },
    }, 1_000, 100);

    const decision = store.decideAndInsertRun(automation, 'manual', 2_000, 2_000);
    expect(decision.kind).toBe('started');

    const completed = store.terminalizeRun(decision.run.id, 'succeeded', undefined, 'summary', {
      now: 3_000,
      outputFullRef: '/tmp/automation-output.json',
    });

    expect(completed?.outputFullRef).toBe('/tmp/automation-output.json');
    expect(completed?.outputSummary).toBe('summary');
  });

  describe('recordRunOutcome (failure tracking + auto-disable)', () => {
    async function makeAutomation(target: AutomationStore = store): Promise<string> {
      const automation = await target.create({
        name: 'Flaky job',
        schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
        missedRunPolicy: 'notify',
        concurrencyPolicy: 'skip',
        action: { prompt: 'Do thing', workingDirectory: '/tmp' },
      }, 1_000, 100);
      return automation.id;
    }

    it('increments the streak and records the failure summary, staying enabled below threshold', async () => {
      const id = await makeAutomation();

      const first = store.recordRunOutcome(id, 'failed', 'boom', 5_000);
      expect(first.autoDisabled).toBe(false);
      expect(first.automation?.consecutiveFailures).toBe(1);
      expect(first.automation?.lastFailureReason).toBe('boom');
      expect(first.automation?.lastFailureAt).toBe(5_000);
      expect(first.automation?.enabled).toBe(true);

      const second = store.recordRunOutcome(id, 'failed', 'boom again', 6_000);
      expect(second.autoDisabled).toBe(false);
      expect(second.automation?.consecutiveFailures).toBe(2);
      expect(second.automation?.lastFailureReason).toBe('boom again');
    });

    it('resets the streak and clears the failure summary on success', async () => {
      const id = await makeAutomation();
      store.recordRunOutcome(id, 'failed', 'boom', 5_000);
      store.recordRunOutcome(id, 'failed', 'boom', 6_000);

      const ok = store.recordRunOutcome(id, 'succeeded', undefined, 7_000);
      expect(ok.autoDisabled).toBe(false);
      expect(ok.automation?.consecutiveFailures).toBe(0);
      expect(ok.automation?.lastFailureAt).toBeNull();
      expect(ok.automation?.lastFailureReason).toBeNull();
    });

    it('auto-disables once the consecutive-failure threshold is reached', async () => {
      const lowThresholdStore = new AutomationStore(db, fakeAttachmentService(), 3);
      const id = await makeAutomation(lowThresholdStore);

      expect(lowThresholdStore.recordRunOutcome(id, 'failed', 'e', 1).autoDisabled).toBe(false);
      expect(lowThresholdStore.recordRunOutcome(id, 'failed', 'e', 2).autoDisabled).toBe(false);
      const third = lowThresholdStore.recordRunOutcome(id, 'failed', 'e', 3);
      expect(third.autoDisabled).toBe(true);
      expect(third.automation?.enabled).toBe(false);
      expect(third.automation?.consecutiveFailures).toBe(3);

      // Already disabled — does not re-report autoDisabled on the next failure.
      const fourth = lowThresholdStore.recordRunOutcome(id, 'failed', 'e', 4);
      expect(fourth.autoDisabled).toBe(false);
      expect(fourth.automation?.enabled).toBe(false);
      expect(fourth.automation?.consecutiveFailures).toBe(4);
    });

    it('ignores skipped and cancelled outcomes (they do not break the streak)', async () => {
      const id = await makeAutomation();
      store.recordRunOutcome(id, 'failed', 'boom', 5_000);

      const skipped = store.recordRunOutcome(id, 'skipped', 'concurrency', 6_000);
      expect(skipped.automation).toBeNull();
      expect(skipped.autoDisabled).toBe(false);

      const after = await store.get(id);
      expect(after?.consecutiveFailures).toBe(1);
      expect(after?.lastFailureReason).toBe('boom');
    });

    it('clears the failure streak when a disabled automation is re-enabled', async () => {
      const lowThresholdStore = new AutomationStore(db, fakeAttachmentService(), 2);
      const id = await makeAutomation(lowThresholdStore);
      lowThresholdStore.recordRunOutcome(id, 'failed', 'e', 1);
      const disabled = lowThresholdStore.recordRunOutcome(id, 'failed', 'e', 2);
      expect(disabled.autoDisabled).toBe(true);

      const reEnabled = await lowThresholdStore.update(id, { enabled: true }, undefined, 9_000);
      expect(reEnabled.enabled).toBe(true);
      expect(reEnabled.consecutiveFailures).toBe(0);
      expect(reEnabled.lastFailureAt).toBeNull();
      expect(reEnabled.lastFailureReason).toBeNull();
    });

    it('uses a sane default threshold', () => {
      expect(DEFAULT_MAX_CONSECUTIVE_FAILURES).toBeGreaterThan(0);
    });
  });

  describe('insertRetryRun (B10b retry tracking)', () => {
    async function makeAutomation(): Promise<ReturnType<AutomationStore['decideAndInsertRun']> & { kind: 'started'; automationId: string }> {
      const automation = await store.create({
        name: 'Retry job',
        schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
        missedRunPolicy: 'notify',
        concurrencyPolicy: 'skip',
        action: { prompt: 'Do thing', workingDirectory: '/tmp' },
      }, 1_000, 100);
      const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, { maxAttempts: 3, attempt: 1 });
      return { ...decision, automationId: automation.id } as ReturnType<AutomationStore['decideAndInsertRun']> & { kind: 'started'; automationId: string };
    }

    it('creates a new run record with incremented attempt number', async () => {
      const decision = await makeAutomation();
      expect(decision.kind).toBe('started');
      if (decision.kind !== 'started') return;
      const original = decision.run;
      expect(original.attempt).toBe(1);
      expect(original.maxAttempts).toBe(3);

      // Terminalize as failed
      store.terminalizeRun(original.id, 'failed', 'transient error', undefined, 2_000);

      const retryRun = store.insertRetryRun(original, 2, 3, 3_000, 3_000);
      expect(retryRun).not.toBeNull();
      expect(retryRun?.attempt).toBe(2);
      expect(retryRun?.maxAttempts).toBe(3);
      expect(retryRun?.automationId).toBe(original.automationId);
      expect(retryRun?.status).toBe('running');
      expect(retryRun?.trigger).toBe('scheduled');
    });

    it('preserves the original config snapshot in the retry run', async () => {
      const decision = await makeAutomation();
      if (decision.kind !== 'started') return;
      const original = decision.run;
      store.terminalizeRun(original.id, 'failed', 'boom', undefined, 2_000);

      const retryRun = store.insertRetryRun(original, 2, 3, 3_000, 3_000);
      expect(retryRun?.configSnapshot?.action.prompt).toBe('Do thing');
      expect(retryRun?.configSnapshot?.action.workingDirectory).toBe('/tmp');
    });

    it('returns null when the automation no longer exists', async () => {
      const decision = await makeAutomation();
      if (decision.kind !== 'started') return;
      const original = decision.run;
      store.terminalizeRun(original.id, 'failed', 'boom', undefined, 2_000);
      db.prepare('DELETE FROM automations WHERE id = ?').run(original.automationId);

      const retryRun = store.insertRetryRun(original, 2, 3, 3_000, 3_000);
      expect(retryRun).toBeNull();
    });
  });

  describe('attempt and maxAttempts columns on runs', () => {
    it('defaults to attempt=1 maxAttempts=1 when not specified', async () => {
      const automation = await store.create({
        name: 'Default run',
        schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
        missedRunPolicy: 'notify',
        concurrencyPolicy: 'skip',
        action: { prompt: 'Go', workingDirectory: '/tmp' },
      }, 1_000, 100);
      const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000);
      expect(decision.kind).toBe('started');
      if (decision.kind !== 'started') return;
      expect(decision.run.attempt).toBe(1);
      expect(decision.run.maxAttempts).toBe(1);
    });

    it('persists custom attempt and maxAttempts values', async () => {
      const automation = await store.create({
        name: 'Custom attempt',
        schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
        missedRunPolicy: 'notify',
        concurrencyPolicy: 'skip',
        action: { prompt: 'Go', workingDirectory: '/tmp' },
      }, 1_000, 100);
      const decision = store.decideAndInsertRun(automation, 'manual', 1_000, 1_000, {
        attempt: 2,
        maxAttempts: 5,
      });
      expect(decision.kind).toBe('started');
      if (decision.kind !== 'started') return;
      expect(decision.run.attempt).toBe(2);
      expect(decision.run.maxAttempts).toBe(5);
    });
  });

  describe('workspace id', () => {
    it('derives a normalized workspace id from the working directory', async () => {
      const automation = await store.create({
        name: 'Cased dir',
        schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
        missedRunPolicy: 'notify',
        concurrencyPolicy: 'skip',
        action: { prompt: 'Go', workingDirectory: '/Users/James/Repo' },
      }, 1_000, 100);
      expect(automation.workspaceId).toBe('/users/james/repo');

      const reread = await store.get(automation.id);
      expect(reread?.workspaceId).toBe('/users/james/repo');
    });

    it('uses the no-workspace sentinel when the directory is blank', async () => {
      const automation = await store.create({
        name: 'No dir',
        schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
        missedRunPolicy: 'notify',
        concurrencyPolicy: 'skip',
        action: { prompt: 'Go', workingDirectory: '   ' },
      }, 1_000, 100);
      expect(automation.workspaceId).toBe('__no_workspace__');
    });

    it('re-syncs the workspace id when the working directory changes', async () => {
      const automation = await store.create({
        name: 'Movable',
        schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
        missedRunPolicy: 'notify',
        concurrencyPolicy: 'skip',
        action: { prompt: 'Go', workingDirectory: '/tmp/a' },
      }, 1_000, 100);
      expect(automation.workspaceId).toBe('/tmp/a');

      const updated = await store.update(automation.id, {
        action: { prompt: 'Go', workingDirectory: '/tmp/B' },
      }, 1_000);
      expect(updated.workspaceId).toBe('/tmp/b');
    });
  });
	});
