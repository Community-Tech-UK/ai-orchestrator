/**
 * Integration tests for B10b: retry/backoff + streak interaction.
 *
 * Covers:
 *  - Intermediate retry failures do NOT increment the consecutive-failure streak.
 *  - Give-up (all attempts exhausted) DOES increment the streak and may auto-disable.
 *  - Retry timers are owned by the scheduler and are cleaned up on deactivate/stop.
 *  - The scheduler clears retries when deactivate() is called for the automation.
 *
 * BUG FIX TESTS:
 *  BUG 1 — oneTime run-terminal listener uses deactivateSchedule, not deactivate,
 *           so retries survive.
 *  BUG 2 — retries are persisted to DB and re-armed after restart.
 *  BUG 3 — retries respect concurrencyPolicy (skip/queue) before dispatching.
 *  BUG 4 — cancelRetry/deactivate clear persisted pending-retry fields;
 *           double-scheduling the same run fires exactly once.
 */

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
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
import { AutomationRunner } from './automation-runner';
import { AutomationScheduler } from './automation-scheduler';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import { CatchUpCoordinator } from './catch-up-coordinator';
import type { AutomationRun } from '../../shared/types/automation.types';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/ai-orchestrator-test') },
  powerMonitor: new EventEmitter(),
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../channels/channel-manager', () => ({
  getChannelManager: () => ({ getAdapter: vi.fn(), emitResponseSent: vi.fn() }),
}));

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

function makeStore(db: SqliteDriver, maxConsecutiveFailures = 5): AutomationStore {
  return new AutomationStore(db, fakeAttachmentService(), maxConsecutiveFailures);
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function createTestAutomation(store: AutomationStore): Promise<string> {
  const a = await store.create({
    name: 'Retryable job',
    schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
    missedRunPolicy: 'notify',
    concurrencyPolicy: 'skip',
    action: { prompt: 'Do work', workingDirectory: '/tmp' },
  }, 1_000, 100);
  return a.id;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests: streak isolation
// ──────────────────────────────────────────────────────────────────────────────

describe('AutomationRunner retry/streak interaction (B10b)', () => {
  let db: SqliteDriver;
  let store: AutomationStore;
  let capturedRetries: { originalRun: AutomationRun; nextAttempt: number; maxAttempts: number; delayMs: number }[];

  beforeEach(() => {
    resetAutomationEventsForTesting();
    db = createDb();
    // Use threshold of 3 so we hit auto-disable quickly in tests.
    store = makeStore(db, 3);
    capturedRetries = [];
  });

  afterEach(() => {
    db.close();
  });

  function makeRunner(maxRetryAttempts = 3, baseDelay = 100): AutomationRunner {
    const runner = new AutomationRunner(
      store,
      getAutomationEvents(),
      () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }),
      maxRetryAttempts,
      baseDelay,
    );
    // Capture retry calls without actually scheduling timers.
    runner.setRetryScheduler((originalRun, nextAttempt, maxAttempts, delayMs) => {
      capturedRetries.push({ originalRun, nextAttempt, maxAttempts, delayMs });
    });
    return runner;
  }

  it('intermediate failures (attempt < maxAttempts) do NOT increment the streak', async () => {
    const id = await createTestAutomation(store);
    const runner = makeRunner(3);

    const automation = await store.get(id);
    const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, {
      maxAttempts: 3,
      attempt: 1,
    });
    expect(decision.kind).toBe('started');
    if (decision.kind !== 'started') return;

    // Terminalize as failed (attempt 1 of 3)
    const failedRun = store.terminalizeRun(decision.run.id, 'failed', 'transient', undefined, 2_000)!;

    // Runner processes the terminal run
    (runner as unknown as { handleTerminalRun: (r: AutomationRun) => void }).handleTerminalRun(failedRun);

    // A retry should have been scheduled
    expect(capturedRetries).toHaveLength(1);
    expect(capturedRetries[0]!.nextAttempt).toBe(2);

    // Streak must NOT have been incremented
    const afterFirstFail = await store.get(id);
    expect(afterFirstFail?.consecutiveFailures).toBe(0);
    expect(afterFirstFail?.lastFailureReason).toBeNull();
  });

  it('second intermediate failure (attempt 2 of 3) also does NOT increment streak', async () => {
    const id = await createTestAutomation(store);
    const runner = makeRunner(3);

    const automation = await store.get(id);
    const d = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, { maxAttempts: 3, attempt: 1 });
    if (d.kind !== 'started') return;
    const failedRun1 = store.terminalizeRun(d.run.id, 'failed', 'err1', undefined, 2_000)!;
    (runner as unknown as { handleTerminalRun: (r: AutomationRun) => void }).handleTerminalRun(failedRun1);

    // Simulate the retry run (attempt 2)
    const retryRun2 = store.insertRetryRun(failedRun1, 2, 3, 3_000, 3_000)!;
    const failedRetry2 = store.terminalizeRun(retryRun2.id, 'failed', 'err2', undefined, 4_000)!;
    (runner as unknown as { handleTerminalRun: (r: AutomationRun) => void }).handleTerminalRun(failedRetry2);

    // Another retry should be scheduled
    expect(capturedRetries).toHaveLength(2);
    expect(capturedRetries[1]!.nextAttempt).toBe(3);

    // Streak still zero — no final give-up yet
    const after = await store.get(id);
    expect(after?.consecutiveFailures).toBe(0);
  });

  it('final give-up (attempt === maxAttempts) DOES increment streak', async () => {
    const id = await createTestAutomation(store);
    const runner = makeRunner(3);

    const automation = await store.get(id);
    const d = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, { maxAttempts: 3, attempt: 1 });
    if (d.kind !== 'started') return;
    const failedRun1 = store.terminalizeRun(d.run.id, 'failed', 'err1', undefined, 2_000)!;
    (runner as unknown as { handleTerminalRun: (r: AutomationRun) => void }).handleTerminalRun(failedRun1);

    const retryRun2 = store.insertRetryRun(failedRun1, 2, 3, 3_000, 3_000)!;
    const failedRetry2 = store.terminalizeRun(retryRun2.id, 'failed', 'err2', undefined, 4_000)!;
    (runner as unknown as { handleTerminalRun: (r: AutomationRun) => void }).handleTerminalRun(failedRetry2);

    // Simulate the third (final) retry
    const retryRun3 = store.insertRetryRun(retryRun2, 3, 3, 5_000, 5_000)!;
    const failedRetry3 = store.terminalizeRun(retryRun3.id, 'failed', 'final error', undefined, 6_000)!;
    (runner as unknown as { handleTerminalRun: (r: AutomationRun) => void }).handleTerminalRun(failedRetry3);

    // No further retry should have been requested
    expect(capturedRetries).toHaveLength(2); // Only for attempts 1 and 2

    // Streak IS incremented after final give-up
    const after = await store.get(id);
    expect(after?.consecutiveFailures).toBe(1);
    expect(after?.lastFailureReason).toBe('final error');
  });

  it('success resets the streak (even after retries)', async () => {
    const id = await createTestAutomation(store);
    const runner = makeRunner(3);

    const automation = await store.get(id);
    const d = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, { maxAttempts: 3, attempt: 1 });
    if (d.kind !== 'started') return;
    const failedRun = store.terminalizeRun(d.run.id, 'failed', 'oops', undefined, 2_000)!;
    (runner as unknown as { handleTerminalRun: (r: AutomationRun) => void }).handleTerminalRun(failedRun);

    // Retry succeeds
    const retryRun = store.insertRetryRun(failedRun, 2, 3, 3_000, 3_000)!;
    const succeeded = store.terminalizeRun(retryRun.id, 'succeeded', undefined, 'done', 4_000)!;
    (runner as unknown as { handleTerminalRun: (r: AutomationRun) => void }).handleTerminalRun(succeeded);

    const after = await store.get(id);
    expect(after?.consecutiveFailures).toBe(0);
    expect(after?.lastFailureReason).toBeNull();
  });

  it('gives up immediately when maxAttempts=1 (no retries)', async () => {
    const id = await createTestAutomation(store);
    // Use runner with maxRetryAttempts=1 so first failure is a give-up.
    const runner = makeRunner(1);

    const automation = await store.get(id);
    const d = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, { maxAttempts: 1, attempt: 1 });
    if (d.kind !== 'started') return;
    const failedRun = store.terminalizeRun(d.run.id, 'failed', 'immediate fail', undefined, 2_000)!;
    (runner as unknown as { handleTerminalRun: (r: AutomationRun) => void }).handleTerminalRun(failedRun);

    // No retries
    expect(capturedRetries).toHaveLength(0);
    // Streak incremented on first failure
    const after = await store.get(id);
    expect(after?.consecutiveFailures).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Tests: wait-failures (awaiting human approval/input) are NOT retried
//
// Regression guard: a guarded automation whose session parks at
// waiting_for_permission previously failed AND retried up to maxAttempts,
// spawning an identical parked session per attempt. Those failures are
// deterministic ("needs a human"), so they must fail once without retrying.
// ──────────────────────────────────────────────────────────────────────────────

describe('AutomationRunner wait-failures are non-retryable', () => {
  let db: SqliteDriver;
  let store: AutomationStore;
  let capturedRetries: { originalRun: AutomationRun; nextAttempt: number; maxAttempts: number; delayMs: number }[];

  beforeEach(() => {
    resetAutomationEventsForTesting();
    db = createDb();
    store = makeStore(db, 3);
    capturedRetries = [];
  });

  afterEach(() => {
    db.close();
  });

  function makeRunner(maxRetryAttempts = 3, baseDelay = 100): AutomationRunner {
    const runner = new AutomationRunner(
      store,
      getAutomationEvents(),
      () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }),
      maxRetryAttempts,
      baseDelay,
    );
    runner.setRetryScheduler((originalRun, nextAttempt, maxAttempts, delayMs) => {
      capturedRetries.push({ originalRun, nextAttempt, maxAttempts, delayMs });
    });
    return runner;
  }

  it('handleTerminalRun with retryable=false skips the retry loop even when attempts remain', async () => {
    const id = await createTestAutomation(store);
    const runner = makeRunner(3);

    const automation = await store.get(id);
    const d = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, { maxAttempts: 3, attempt: 1 });
    if (d.kind !== 'started') return;

    const reason = 'Automation requires unattended permission approval';
    const failedRun = store.terminalizeRun(d.run.id, 'failed', reason, undefined, 2_000)!;

    // attempt 1 of 3 — retryable path would normally schedule a retry here.
    (runner as unknown as {
      handleTerminalRun: (r: AutomationRun, o?: { retryable?: boolean }) => void;
    }).handleTerminalRun(failedRun, { retryable: false });

    // No retry scheduled → no duplicate parked session.
    expect(capturedRetries).toHaveLength(0);
    // Recorded as a final give-up: streak advances by exactly one, same as it
    // would after exhausting retries — semantics preserved, duplicates removed.
    const after = await store.get(id);
    expect(after?.consecutiveFailures).toBe(1);
    expect(after?.lastFailureReason).toBe(reason);
  });

  it('a run parked at waiting_for_permission fails once without scheduling retries', async () => {
    const id = await createTestAutomation(store);
    const runner = makeRunner(3);

    const automation = await store.get(id);
    const d = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, { maxAttempts: 3, attempt: 1 });
    if (d.kind !== 'started') return;

    const instanceId = 'inst-parked';
    // Seed the runner's tracking as if this instance was dispatched for the run.
    (runner as unknown as {
      trackingByInstance: Map<string, { runId: string; automationId: string; seenAssistantOutput: boolean; outputChunks: unknown[] }>;
      instanceByRun: Map<string, string>;
    }).trackingByInstance.set(instanceId, {
      runId: d.run.id,
      automationId: id,
      seenAssistantOutput: false,
      outputChunks: [],
    });
    (runner as unknown as { instanceByRun: Map<string, string> }).instanceByRun.set(d.run.id, instanceId);

    // The session reaches the permission gate — drive the reconcile path.
    (runner as unknown as { reconcileInstanceState: (i: unknown) => void }).reconcileInstanceState({
      id: instanceId,
      status: 'waiting_for_permission',
      outputBuffer: [],
    });

    // Wait-failure: run fails, but no retry is armed (no duplicate spawns).
    expect(capturedRetries).toHaveLength(0);
    const after = await store.get(id);
    expect(after?.consecutiveFailures).toBe(1);
    expect(after?.lastFailureReason).toBe('Automation requires unattended permission approval');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Tests: scheduler timer lifecycle
// ──────────────────────────────────────────────────────────────────────────────

describe('AutomationScheduler retry timer lifecycle (B10b)', () => {
  let db: SqliteDriver;
  let store: AutomationStore;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAutomationEventsForTesting();
    db = createDb();
    store = makeStore(db, 5);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  function makeScheduler(): { scheduler: AutomationScheduler; runner: AutomationRunner } {
    const runner = new AutomationRunner(
      store,
      getAutomationEvents(),
      () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }),
      3,
      100,
    );
    const catchUp = new CatchUpCoordinator(store, runner, getAutomationEvents(), () => Date.now());
    const scheduler = new AutomationScheduler(store, runner, catchUp, getAutomationEvents(), () => Date.now());
    return { scheduler, runner };
  }

  it('scheduleRetry registers a timer that fires after the delay', () => {
    const { scheduler } = makeScheduler();
    const dispatchSpy = vi.spyOn(store, 'insertRetryRun').mockReturnValue(null);

    const fakeRun = {
      id: 'run-1',
      automationId: 'auto-1',
      trigger: 'scheduled' as const,
      deliveryMode: 'notify' as const,
      attempt: 1,
      maxAttempts: 3,
    } as AutomationRun;

    scheduler.scheduleRetry(fakeRun, 2, 3, 500);

    expect(dispatchSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(dispatchSpy).toHaveBeenCalledOnce();
  });

  it('deactivate() cancels pending retry timers for the automation', () => {
    const { scheduler } = makeScheduler();
    const dispatchSpy = vi.spyOn(store, 'insertRetryRun').mockReturnValue(null);

    const fakeRun = {
      id: 'run-2',
      automationId: 'auto-2',
      trigger: 'scheduled' as const,
      deliveryMode: 'notify' as const,
      attempt: 1,
      maxAttempts: 3,
    } as AutomationRun;

    scheduler.scheduleRetry(fakeRun, 2, 3, 1_000);
    scheduler.deactivate('auto-2');

    vi.advanceTimersByTime(2_000);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('cancelRetry() cancels a specific retry timer by run ID', () => {
    const { scheduler } = makeScheduler();
    const dispatchSpy = vi.spyOn(store, 'insertRetryRun').mockReturnValue(null);

    const fakeRun = {
      id: 'run-3',
      automationId: 'auto-3',
      trigger: 'scheduled' as const,
      deliveryMode: 'notify' as const,
      attempt: 1,
      maxAttempts: 3,
    } as AutomationRun;

    scheduler.scheduleRetry(fakeRun, 2, 3, 1_000);
    scheduler.cancelRetry('run-3');

    vi.advanceTimersByTime(2_000);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('scheduling a second retry for the same run cancels the first', () => {
    const { scheduler } = makeScheduler();
    let callCount = 0;
    vi.spyOn(store, 'insertRetryRun').mockImplementation(() => { callCount++; return null; });

    const fakeRun = {
      id: 'run-4',
      automationId: 'auto-4',
      trigger: 'scheduled' as const,
      deliveryMode: 'notify' as const,
      attempt: 1,
      maxAttempts: 3,
    } as AutomationRun;

    scheduler.scheduleRetry(fakeRun, 2, 3, 1_000);
    // Schedule again before the first fires
    scheduler.scheduleRetry(fakeRun, 2, 3, 500);

    vi.advanceTimersByTime(2_000);
    // Only the second timer should have fired, so callCount === 1
    expect(callCount).toBe(1);
  });

  it('retry timer for one automation does not prevent another automation from retrying', () => {
    const { scheduler } = makeScheduler();
    const dispatchSpy = vi.spyOn(store, 'insertRetryRun').mockReturnValue(null);

    const run1 = { id: 'run-5', automationId: 'auto-5', trigger: 'scheduled' as const, deliveryMode: 'notify' as const, attempt: 1, maxAttempts: 3 } as AutomationRun;
    const run2 = { id: 'run-6', automationId: 'auto-6', trigger: 'scheduled' as const, deliveryMode: 'notify' as const, attempt: 1, maxAttempts: 3 } as AutomationRun;

    scheduler.scheduleRetry(run1, 2, 3, 500);
    scheduler.scheduleRetry(run2, 2, 3, 500);

    // Cancel only automation 5's retry
    scheduler.deactivate('auto-5');

    vi.advanceTimersByTime(1_000);
    // Only run2's retry should have fired
    expect(dispatchSpy).toHaveBeenCalledOnce();
    expect(dispatchSpy).toHaveBeenCalledWith(run2, 2, 3, expect.any(Number), expect.any(Number));
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// BUG 1 — oneTime retry survives run-terminal deactivation
// ──────────────────────────────────────────────────────────────────────────────

describe('BUG 1 — oneTime retry survives run-terminal deactivation', () => {
  let db: SqliteDriver;
  let store: AutomationStore;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAutomationEventsForTesting();
    db = createDb();
    store = makeStore(db, 5);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('a failed oneTime run schedules a retry that survives the run-terminal deactivation and fires', async () => {
    // Create a oneTime automation.
    const automation = await store.create({
      name: 'OneTime job',
      schedule: { type: 'oneTime', runAt: 1_000, timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      action: { prompt: 'Do once', workingDirectory: '/tmp' },
    }, 1_000, 100);

    const runner = new AutomationRunner(
      store,
      getAutomationEvents(),
      () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }),
      3,
      100,
    );
    const catchUp = new CatchUpCoordinator(store, runner, getAutomationEvents(), () => Date.now());
    const scheduler = new AutomationScheduler(store, runner, catchUp, getAutomationEvents(), () => Date.now());
    // Do NOT call scheduler.initialize() here to avoid arming a real fire timer
    // that would trigger runner.fire() (which requires an initialized instance manager).
    // We only need the event listeners registered by initialize(), so we call it
    // but mock runner.fire to be a no-op to prevent the spurious unhandled rejection.
    vi.spyOn(runner, 'fire').mockResolvedValue({ status: 'skipped', reason: 'mocked' });
    scheduler.initialize();

    // Insert a running run to simulate the automation having fired.
    const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, {
      maxAttempts: 3,
      attempt: 1,
    });
    expect(decision.kind).toBe('started');
    if (decision.kind !== 'started') return;

    // Spy on insertRetryRun to detect when the retry timer fires.
    const retryInsertSpy = vi.spyOn(store, 'insertRetryRun').mockReturnValue(null);
    // Mock listRuns so the retry timer can proceed past the concurrency check.
    vi.spyOn(store, 'listRuns').mockReturnValue([]);

    // Terminalize the run as failed.
    const failedRun = store.terminalizeRun(decision.run.id, 'failed', 'adapter error', undefined, 2_000)!;

    // Manually invoke handleTerminalRun so the runner schedules a retry.
    (runner as unknown as { handleTerminalRun: (r: AutomationRun) => void }).handleTerminalRun(failedRun);

    // The retry MUST be scheduled at this point.
    // Verify: retryHandles should have an entry for the failed run.
    const retryHandlesBefore = (scheduler as unknown as {
      retryHandles: Map<string, unknown>;
    }).retryHandles;
    expect(retryHandlesBefore.size).toBe(1);

    // Now emit the run-terminal event (simulates the scheduler's own listener).
    // With the BUG 1 fix, this should call deactivateSchedule (not deactivate),
    // leaving the retry timer intact.
    getAutomationEvents().emitRunTerminal({
      automationId: automation.id,
      runId: decision.run.id,
      status: 'failed',
    });

    // The retry timer must still be alive.
    const retryHandlesAfter = (scheduler as unknown as {
      retryHandles: Map<string, unknown>;
    }).retryHandles;
    expect(retryHandlesAfter.size).toBe(1);

    // Advance time so the retry timer fires.
    vi.advanceTimersByTime(300);
    // Give the async onRetryTimer a tick to complete.
    await Promise.resolve();

    // insertRetryRun should have been called by the fired timer.
    expect(retryInsertSpy).toHaveBeenCalledOnce();
  });

  it('runner handleTerminalRun: failed oneTime with retries pending does NOT emit schedule-deactivated', async () => {
    // This tests the runner-side fix: emitScheduleDeactivated is skipped when
    // a retry is pending for a failed oneTime run.
    const automation = await store.create({
      name: 'OneTime with retry',
      schedule: { type: 'oneTime', runAt: 1_000, timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      action: { prompt: 'Do once', workingDirectory: '/tmp' },
    }, 1_000, 100);

    const events = getAutomationEvents();
    let scheduleDeactivatedCount = 0;
    events.on('automation:schedule-deactivated', () => { scheduleDeactivatedCount++; });

    const runner = new AutomationRunner(
      store,
      events,
      () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }),
      3,  // maxRetryAttempts=3 → retries available
      100,
    );
    // Set a no-op retry scheduler so retries are "captured" without real timers.
    runner.setRetryScheduler(() => { /* captured */ });

    const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, {
      maxAttempts: 3, attempt: 1,
    });
    if (decision.kind !== 'started') return;

    const failedRun = store.terminalizeRun(decision.run.id, 'failed', 'oops', undefined, 2_000)!;
    (runner as unknown as { handleTerminalRun: (r: AutomationRun) => void }).handleTerminalRun(failedRun);

    // schedule-deactivated should NOT have been emitted while retries remain.
    expect(scheduleDeactivatedCount).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// BUG 2 — durable pending-retry persistence and rehydration
// ──────────────────────────────────────────────────────────────────────────────

describe('BUG 2 — durable pending-retry: persist on arm, clear on fire/cancel, rehydrate on restart', () => {
  let db: SqliteDriver;
  let store: AutomationStore;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAutomationEventsForTesting();
    db = createDb();
    store = makeStore(db, 5);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  async function createRunAndFail(): Promise<{ runId: string; automationId: string }> {
    const automation = await store.create({
      name: 'Durable retry job',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      action: { prompt: 'Do thing', workingDirectory: '/tmp' },
    }, 1_000, 100);
    const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, {
      maxAttempts: 3,
      attempt: 1,
    });
    expect(decision.kind).toBe('started');
    if (decision.kind !== 'started') throw new Error('unexpected');
    store.terminalizeRun(decision.run.id, 'failed', 'boom', undefined, 2_000);
    return { runId: decision.run.id, automationId: automation.id };
  }

  it('scheduleRetry persists next_retry_at on the failed run', async () => {
    const { runId, automationId } = await createRunAndFail();

    const runner = new AutomationRunner(store, getAutomationEvents(), () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }), 3, 100);
    const catchUp = new CatchUpCoordinator(store, runner, getAutomationEvents(), () => Date.now());
    const scheduler = new AutomationScheduler(store, runner, catchUp, getAutomationEvents(), () => Date.now());

    const originalRun = store.getRun(runId)!;
    scheduler.scheduleRetry(originalRun, 2, 3, 5_000);

    // The DB must have the pending-retry fields set.
    const row = db.prepare('SELECT next_retry_at, next_retry_attempt, next_retry_max_attempts FROM automation_runs WHERE id = ?').get<{
      next_retry_at: number | null;
      next_retry_attempt: number | null;
      next_retry_max_attempts: number | null;
    }>(runId);
    expect(row?.next_retry_at).toBeGreaterThan(0);
    expect(row?.next_retry_attempt).toBe(2);
    expect(row?.next_retry_max_attempts).toBe(3);

    // Cleanup to avoid leaking timer.
    scheduler.cancelRetry(runId);

    // After cancelRetry, the DB fields must be cleared.
    const rowAfterCancel = db.prepare('SELECT next_retry_at, next_retry_attempt, next_retry_max_attempts FROM automation_runs WHERE id = ?').get<{
      next_retry_at: number | null;
      next_retry_attempt: number | null;
      next_retry_max_attempts: number | null;
    }>(runId);
    expect(rowAfterCancel?.next_retry_at).toBeNull();
    expect(rowAfterCancel?.next_retry_attempt).toBeNull();

    void automationId; // suppress unused warning
  });

  it('onRetryTimer clears next_retry_at from the DB when the timer fires', async () => {
    const { runId } = await createRunAndFail();

    const runner = new AutomationRunner(store, getAutomationEvents(), () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }), 3, 100);
    const catchUp = new CatchUpCoordinator(store, runner, getAutomationEvents(), () => Date.now());
    const scheduler = new AutomationScheduler(store, runner, catchUp, getAutomationEvents(), () => Date.now());

    // Mock insertRetryRun so the timer fires without needing a real automation.
    vi.spyOn(store, 'insertRetryRun').mockReturnValue(null);
    vi.spyOn(store, 'listRuns').mockReturnValue([]);

    const originalRun = store.getRun(runId)!;
    scheduler.scheduleRetry(originalRun, 2, 3, 500);

    // Advance past the delay.
    vi.advanceTimersByTime(600);
    // Give the async onRetryTimer a tick to complete.
    await Promise.resolve();

    const row = db.prepare('SELECT next_retry_at FROM automation_runs WHERE id = ?').get<{
      next_retry_at: number | null;
    }>(runId);
    expect(row?.next_retry_at).toBeNull();
  });

  it('initialize() re-arms a pending retry that survived a restart', async () => {
    const { runId, automationId } = await createRunAndFail();

    // Simulate the app having set these fields before the "restart".
    const futureRetryAt = Date.now() + 5_000;
    store.markPendingRetry(runId, futureRetryAt, 2, 3);

    const runner = new AutomationRunner(store, getAutomationEvents(), () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }), 3, 100);
    const catchUp = new CatchUpCoordinator(store, runner, getAutomationEvents(), () => Date.now());
    const scheduler = new AutomationScheduler(store, runner, catchUp, getAutomationEvents(), () => Date.now());

    vi.spyOn(store, 'insertRetryRun').mockReturnValue(null);
    vi.spyOn(store, 'listRuns').mockReturnValue([]);
    // Prevent 'fire' from throwing when the scheduled-fire timer coincidentally fires.
    vi.spyOn(runner, 'fire').mockResolvedValue({ status: 'skipped', reason: 'mocked' });

    // initialize() should re-arm the retry.
    scheduler.initialize();

    const retryHandles = (scheduler as unknown as { retryHandles: Map<string, unknown> }).retryHandles;
    expect(retryHandles.has(runId)).toBe(true);

    // Advance time — the timer should fire.
    vi.advanceTimersByTime(6_000);
    await Promise.resolve();

    expect(store.insertRetryRun).toHaveBeenCalled();

    void automationId;
  });

  it('listPendingRetries does NOT return a run that already has a successor retry run', async () => {
    const { runId, automationId } = await createRunAndFail();

    store.markPendingRetry(runId, Date.now() + 5_000, 2, 3);

    // Insert the successor retry run (attempt 2).
    const originalRun = store.getRun(runId)!;
    store.insertRetryRun(originalRun, 2, 3, Date.now() + 5_000, Date.now() + 5_000);

    const pending = store.listPendingRetries();
    expect(pending.find((p) => p.runId === runId)).toBeUndefined();

    void automationId;
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// BUG 3 — concurrencyPolicy respected in onRetryTimer
// ──────────────────────────────────────────────────────────────────────────────

describe('BUG 3 — onRetryTimer respects concurrencyPolicy', () => {
  let db: SqliteDriver;
  let store: AutomationStore;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAutomationEventsForTesting();
    db = createDb();
    store = makeStore(db, 5);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  async function setupAutomation(concurrencyPolicy: 'skip' | 'queue') {
    const automation = await store.create({
      name: `Concurrent job (${concurrencyPolicy})`,
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy,
      action: { prompt: 'Do thing', workingDirectory: '/tmp' },
    }, 1_000, 100);
    return automation;
  }

  it('policy=skip: retry is skipped when a run is already active', async () => {
    const automation = await setupAutomation('skip');

    // Start a run that will still be active when the retry fires.
    const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, {
      maxAttempts: 3, attempt: 1,
    });
    expect(decision.kind).toBe('started');
    if (decision.kind !== 'started') return;

    // Terminalize the first run as failed (the retry will be for attempt 2).
    const failedRun = store.terminalizeRun(decision.run.id, 'failed', 'err', undefined, 2_000)!;

    // Start a SECOND (concurrent) run to simulate an active run at retry time.
    const concurrent = store.decideAndInsertRun(automation, 'manual', 3_000, 3_000);
    expect(concurrent.kind).toBe('started');

    const runner = new AutomationRunner(store, getAutomationEvents(), () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }), 3, 100);
    const catchUp = new CatchUpCoordinator(store, runner, getAutomationEvents(), () => Date.now());
    const scheduler = new AutomationScheduler(store, runner, catchUp, getAutomationEvents(), () => Date.now());

    const insertRetrySpy = vi.spyOn(store, 'insertRetryRun');

    // Schedule the retry (attempt 2 of 3 — not the last attempt).
    scheduler.scheduleRetry(failedRun, 2, 3, 500);
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    // insertRetryRun must NOT be called because a run is active and policy=skip.
    expect(insertRetrySpy).not.toHaveBeenCalled();

    // The concurrent run is still active — not a final attempt, so no streak increment.
    const after = await store.get(automation.id);
    expect(after?.consecutiveFailures).toBe(0);
  });

  it('policy=skip, last attempt: skipping records give-up outcome and increments streak', async () => {
    const automation = await setupAutomation('skip');
    const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, {
      maxAttempts: 2, attempt: 1,
    });
    if (decision.kind !== 'started') return;
    const failedRun = store.terminalizeRun(decision.run.id, 'failed', 'err', undefined, 2_000)!;

    // Start a concurrent run.
    store.decideAndInsertRun(automation, 'manual', 3_000, 3_000);

    const runner = new AutomationRunner(store, getAutomationEvents(), () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }), 2, 100);
    const catchUp = new CatchUpCoordinator(store, runner, getAutomationEvents(), () => Date.now());
    const scheduler = new AutomationScheduler(store, runner, catchUp, getAutomationEvents(), () => Date.now());

    // Retry attempt 2 of 2 — this IS the last attempt.
    scheduler.scheduleRetry(failedRun, 2, 2, 500);
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    // Give-up must have been recorded, incrementing the streak.
    const after = await store.get(automation.id);
    expect(after?.consecutiveFailures).toBe(1);
  });

  it('policy=queue: retry is inserted as pending when a run is active', async () => {
    const automation = await setupAutomation('queue');
    const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, {
      maxAttempts: 3, attempt: 1,
    });
    if (decision.kind !== 'started') return;
    const failedRun = store.terminalizeRun(decision.run.id, 'failed', 'err', undefined, 2_000)!;

    // Start a concurrent run.
    const concurrent = store.decideAndInsertRun(automation, 'manual', 3_000, 3_000);
    expect(concurrent.kind).toBe('started');

    const runner = new AutomationRunner(store, getAutomationEvents(), () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }), 3, 100);
    const catchUp = new CatchUpCoordinator(store, runner, getAutomationEvents(), () => Date.now());
    const scheduler = new AutomationScheduler(store, runner, catchUp, getAutomationEvents(), () => Date.now());

    const insertRetrySpy = vi.spyOn(store, 'insertRetryRun');
    const insertPendingSpy = vi.spyOn(store, 'insertPendingRetryRun').mockReturnValue(null);

    scheduler.scheduleRetry(failedRun, 2, 3, 500);
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    // insertRetryRun (running) must NOT be called.
    expect(insertRetrySpy).not.toHaveBeenCalled();
    // insertPendingRetryRun must be called instead.
    expect(insertPendingSpy).toHaveBeenCalledOnce();
    expect(insertPendingSpy).toHaveBeenCalledWith(
      failedRun, 2, 3, expect.any(Number), expect.any(Number),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// BUG 4 — cancellation clears persisted fields; double-scheduling fires once
// ──────────────────────────────────────────────────────────────────────────────

describe('BUG 4 — cancellation clears persistence; double-scheduling does not double-fire', () => {
  let db: SqliteDriver;
  let store: AutomationStore;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAutomationEventsForTesting();
    db = createDb();
    store = makeStore(db, 5);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  async function makeFailedRun(): Promise<AutomationRun> {
    const automation = await store.create({
      name: 'Cancel test',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      action: { prompt: 'Go', workingDirectory: '/tmp' },
    }, 1_000, 100);
    const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, {
      maxAttempts: 3, attempt: 1,
    });
    if (decision.kind !== 'started') throw new Error('unexpected');
    return store.terminalizeRun(decision.run.id, 'failed', 'boom', undefined, 2_000)!;
  }

  it('deactivate() clears persisted pending-retry fields from the DB', async () => {
    const failedRun = await makeFailedRun();

    const runner = new AutomationRunner(store, getAutomationEvents(), () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }), 3, 100);
    const catchUp = new CatchUpCoordinator(store, runner, getAutomationEvents(), () => Date.now());
    const scheduler = new AutomationScheduler(store, runner, catchUp, getAutomationEvents(), () => Date.now());

    scheduler.scheduleRetry(failedRun, 2, 3, 5_000);

    // Verify fields are set.
    const before = db.prepare('SELECT next_retry_at FROM automation_runs WHERE id = ?')
      .get<{ next_retry_at: number | null }>(failedRun.id);
    expect(before?.next_retry_at).not.toBeNull();

    // Deactivate the whole automation — must clear retry fields.
    scheduler.deactivate(failedRun.automationId);

    const after = db.prepare('SELECT next_retry_at FROM automation_runs WHERE id = ?')
      .get<{ next_retry_at: number | null }>(failedRun.id);
    expect(after?.next_retry_at).toBeNull();

    // Timer must be gone — no fire after the delay.
    const insertSpy = vi.spyOn(store, 'insertRetryRun');
    vi.advanceTimersByTime(10_000);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('double-scheduling the same run fires exactly once (not twice)', async () => {
    const failedRun = await makeFailedRun();

    const runner = new AutomationRunner(store, getAutomationEvents(), () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }), 3, 100);
    const catchUp = new CatchUpCoordinator(store, runner, getAutomationEvents(), () => Date.now());
    const scheduler = new AutomationScheduler(store, runner, catchUp, getAutomationEvents(), () => Date.now());

    let fireCount = 0;
    vi.spyOn(store, 'insertRetryRun').mockImplementation(() => { fireCount++; return null; });
    vi.spyOn(store, 'listRuns').mockReturnValue([]);

    // Schedule twice — the second call should cancel the first.
    scheduler.scheduleRetry(failedRun, 2, 3, 1_000);
    scheduler.scheduleRetry(failedRun, 2, 3, 500);

    vi.advanceTimersByTime(2_000);
    await Promise.resolve();

    expect(fireCount).toBe(1);
  });
});
