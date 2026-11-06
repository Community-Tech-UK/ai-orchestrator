/**
 * 8c — quiet replies. A succeeded run whose final reply ends in the sentinel
 * is filed quiet and is already seen before the terminal handling announces it
 * (so the unread badge never lights). Anything else is not quiet.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Automation, AutomationRun, AutomationTrigger } from '../../shared/types/automation.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import { QUIET_RUN_SENTINEL } from './automation-run-quiet';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/ai-orchestrator-test') },
}));

vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));

// Account routing has its own tests; these runs must not read real settings.
vi.mock('./automation-account-rules', () => ({ automationAccountPreferences: async () => undefined }));

const channel = vi.hoisted(() => ({ sendMessage: vi.fn(async () => ({ messageId: 'sent-1' })), emitResponseSent: vi.fn() }));
vi.mock('../channels/channel-manager', () => ({
  getChannelManager: () => ({ getAdapter: () => ({ sendMessage: channel.sendMessage }), emitResponseSent: channel.emitResponseSent }),
}));

const checkStoreMocks = vi.hoisted(() => ({
  setRunOutcome: vi.fn(),
  clearPending: vi.fn(),
}));

vi.mock('./automation-check-store', () => ({
  getAutomationCheckStore: () => checkStoreMocks,
}));

// Keep the run-output file out of the test's disk.
vi.mock('./automation-runner-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./automation-runner-helpers')>()),
  writeFullOutput: () => undefined,
}));

const callLog: string[] = [];

function makeAutomation(): Automation {
  return {
    id: 'automation-1',
    name: 'Leads watch',
    enabled: true,
    active: true,
    workspaceId: '/repo/current',
    schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
    trigger: { kind: 'schedule' },
    missedRunPolicy: 'notify',
    concurrencyPolicy: 'skip',
    destination: { kind: 'newInstance' },
    action: { prompt: 'Check the leads panel', workingDirectory: '/repo/current' },
    nextFireAt: null,
    lastFiredAt: null,
    lastRunId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function makeRun(): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    status: 'running',
    trigger: 'scheduled',
    scheduledAt: 2_000,
    startedAt: 2_000,
    finishedAt: null,
    instanceId: null,
    loopRunId: null,
    error: null,
    outputSummary: null,
    outputFullRef: null,
    idempotencyKey: null,
    triggerSource: null,
    deliveryMode: 'silent',
    seenAt: null,
    createdAt: 2_000,
    updatedAt: 2_000,
    attempt: 1,
    maxAttempts: 1,
    configSnapshot: {
      name: 'Leads watch',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      trigger: { kind: 'schedule' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      destination: { kind: 'newInstance' },
      action: { prompt: 'Check the leads panel', workingDirectory: '/repo/current' },
    },
  };
}

describe('AutomationRunner quiet replies (8c)', () => {
  const store = {
    get: vi.fn(),
    decideAndInsertRun: vi.fn(),
    claimNextPending: vi.fn(),
    failRunningRuns: vi.fn(),
    listRunningLoopLinkedRuns: vi.fn(() => []),
    recordRunOutcome: vi.fn(),
    terminalizeRun: vi.fn(),
    attachInstance: vi.fn(),
    markSeen: vi.fn(),
    getRun: vi.fn(),
    getRunFacts: vi.fn(() => ({ result: null })),
    markDeliveryStarted: vi.fn(() => true),
  } as unknown as AutomationStore;
  const manager = Object.assign(new EventEmitter(), {
    createInstance: vi.fn(),
    getInstance: vi.fn(),
    queueInstanceUpdate: vi.fn(),
  }) as unknown as InstanceManager & { createInstance: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    callLog.length = 0;
    resetAutomationEventsForTesting();
    manager.removeAllListeners();
    const run = makeRun();
    vi.mocked(store.get).mockResolvedValue(makeAutomation());
    vi.mocked(store.decideAndInsertRun).mockReturnValue({ kind: 'started', run });
    vi.mocked(store.claimNextPending).mockReturnValue(null);
    vi.mocked(store.getRun).mockReturnValue(null);
    vi.mocked(store.failRunningRuns).mockReturnValue([]);
    vi.mocked(store.recordRunOutcome).mockReturnValue({ automation: null, autoDisabled: false });
    vi.mocked(store.attachInstance).mockImplementation((runId, instanceId) => ({ ...run, id: runId, instanceId }));
    vi.mocked(store.terminalizeRun).mockImplementation((runId, status, error, outputSummary) => ({
      ...run,
      id: runId,
      status,
      error: error ?? null,
      outputSummary: outputSummary ?? null,
      finishedAt: 3_000,
    }));
    vi.mocked(store.markSeen).mockImplementation(() => {
      callLog.push('markSeen');
      return 1;
    });
    const events = getAutomationEvents();
    vi.spyOn(events, 'emitRunChanged').mockImplementation(() => { callLog.push('emitRunChanged'); return true; });
    vi.spyOn(events, 'emitRunTerminal').mockImplementation(() => { callLog.push('emitRunTerminal'); return true; });
  });

  /** Fire a scheduled new-instance run whose instance has already produced `finalReply`, then let it go idle. */
  async function runToIdle(finalReply: string, trigger: AutomationTrigger = 'scheduled', retry = false): Promise<void> {
    const run = { ...makeRun(), trigger, deliveryMode: 'notify' as const,
      triggerSource: { type: 'channel' as const, channel: 'discord:chat-1' } };
    vi.mocked(store.decideAndInsertRun).mockReturnValue({ kind: 'started', run });
    vi.mocked(store.terminalizeRun).mockImplementation((runId, status, error, outputSummary) => ({
      ...run, id: runId, status, error: error ?? null, outputSummary: outputSummary ?? null, finishedAt: 3_000,
    }));
    const instance = {
      id: 'i-quiet',
      outputBuffer: [{ type: 'assistant', content: finalReply, timestamp: 1 }],
      status: 'working',
      metadata: {},
    };
    manager.createInstance.mockResolvedValue(instance);
    vi.mocked(manager.getInstance).mockReturnValue(instance as never);
    // A retry is only dispatched while its run is still running.
    vi.mocked(store.getRun).mockReturnValue(run);
    const runner = new AutomationRunner(store, getAutomationEvents(), () => 2_000, vi.fn());
    runner.initialize(manager);
    if (retry) await runner.dispatchRetryRun({ ...run, attempt: 2 });
    else await runner.fire('automation-1', { trigger, scheduledAt: 2_000 });
    manager.emit('instance:event', {
      instanceId: 'i-quiet',
      event: { kind: 'status_changed', status: 'idle' },
    });
    // A turn settles on the provider's completion event, which carries the receipt.
    manager.emit('provider:normalized-event', { instanceId: 'i-quiet', event: { kind: 'complete' } });
  }

  it('preserves literal output when a scheduled thread wake-up is tracked after Resume', () => {
    const run = makeRun();
    run.configSnapshot!.destination = { kind: 'thread', instanceId: 'i-thread', reviveIfArchived: false };
    vi.mocked(store.getRun).mockReturnValue(run);
    vi.mocked(manager.getInstance).mockReturnValue({ id: 'i-thread', status: 'working', outputBuffer: [], metadata: {} } as never);
    const runner = new AutomationRunner(store, getAutomationEvents(), () => 2_000, vi.fn());
    runner.initialize(manager);
    runner.resumeRunForGlobalPause(run.id, 'i-thread');
    manager.emit('provider:normalized-event', {
      instanceId: 'i-thread', event: { kind: 'output', messageType: 'assistant', content: QUIET_RUN_SENTINEL },
    });
    manager.emit('provider:normalized-event', { instanceId: 'i-thread', event: { kind: 'complete' } });
    expect(store.terminalizeRun).toHaveBeenCalledWith('run-1', 'succeeded', undefined, QUIET_RUN_SENTINEL, expect.anything());
    expect(checkStoreMocks.setRunOutcome).not.toHaveBeenCalled();
    expect(store.markSeen).not.toHaveBeenCalled();
  });

  for (const retry of [false, true]) {
    it.each(['manual', 'webhook', 'channel', 'providerRuntime', 'orchestrationEvent'] as const)(
      `preserves a literal sentinel and channel delivery for %s (retry: ${retry})`, async trigger => {
        const reply = `Literal reply\n${QUIET_RUN_SENTINEL}`;
        await runToIdle(reply, trigger, retry);
        expect(store.terminalizeRun).toHaveBeenCalledWith('run-1', 'succeeded', undefined, reply, expect.anything());
        expect(checkStoreMocks.setRunOutcome).not.toHaveBeenCalled();
        expect(store.markSeen).not.toHaveBeenCalled();
        const announced = vi.mocked(getAutomationEvents().emitRunChanged).mock.calls.at(-1)?.[0].run;
        expect(announced?.seenAt).toBeNull();
        expect(announced?.outcome).not.toBe('quiet');
        await vi.waitFor(() => expect(channel.sendMessage).toHaveBeenCalledOnce());
        expect(channel.sendMessage).toHaveBeenCalledWith('chat-1', expect.stringContaining(reply), undefined);
      },
    );
    it.each(['scheduled', 'catchUp'] as const)(`keeps %s quiet (retry: ${retry})`, async trigger => {
      await runToIdle(`Nothing new\n${QUIET_RUN_SENTINEL}`, trigger, retry);
      expect(checkStoreMocks.setRunOutcome).toHaveBeenCalledWith('run-1', 'quiet');
      expect(store.markSeen).toHaveBeenCalledWith({ runId: 'run-1' });
      expect(channel.sendMessage).not.toHaveBeenCalled();
    });
  }

  it('a final reply ending in the sentinel ends succeeded/quiet and is already seen', async () => {
    await runToIdle(`The leads panel returned 200, so there is nothing to tell James.\n${QUIET_RUN_SENTINEL}\n`);

    expect(store.terminalizeRun).toHaveBeenCalledWith(
      'run-1', 'succeeded', undefined,
      // The stored summary keeps the reply with the sentinel line removed.
      'The leads panel returned 200, so there is nothing to tell James.',
      expect.anything(),
    );
    expect(checkStoreMocks.setRunOutcome).toHaveBeenCalledWith('run-1', 'quiet');
    expect(store.markSeen).toHaveBeenCalledWith({ runId: 'run-1' });
    // Seen first, announced second: the unread badge must never see an unseen quiet run.
    expect(callLog.indexOf('markSeen')).toBeGreaterThanOrEqual(0);
    // (the earlier emitRunChanged is the non-terminal "instance attached" announcement)
    expect(callLog.indexOf('markSeen')).toBeLessThan(callLog.lastIndexOf('emitRunChanged'));
    expect(callLog.indexOf('markSeen')).toBeLessThan(callLog.indexOf('emitRunTerminal'));
    const announced = vi.mocked(getAutomationEvents().emitRunChanged).mock.calls.at(-1)?.[0].run;
    expect(announced).toMatchObject({ status: 'succeeded', outcome: 'quiet', seenAt: 2_000 });
  });

  it('the sentinel quoted mid-reply is not quiet', async () => {
    await runToIdle(
      `I will not end with ${QUIET_RUN_SENTINEL} yet.\nThree new leads arrived; please look at them.`,
    );

    expect(store.terminalizeRun).toHaveBeenCalledWith(
      'run-1', 'succeeded', undefined, expect.stringContaining(QUIET_RUN_SENTINEL), expect.anything(),
    );
    expect(checkStoreMocks.setRunOutcome).not.toHaveBeenCalled();
    expect(store.markSeen).not.toHaveBeenCalled();
    const announced = vi.mocked(getAutomationEvents().emitRunChanged).mock.calls.at(-1)?.[0].run;
    expect(announced?.outcome).toBeUndefined();
    expect(announced?.seenAt).toBeNull();
  });

  it('the sentinel on its own line followed by more text is not quiet', async () => {
    await runToIdle(`${QUIET_RUN_SENTINEL}\nActually, one lead needs a reply today.`);

    expect(checkStoreMocks.setRunOutcome).not.toHaveBeenCalled();
    expect(store.markSeen).not.toHaveBeenCalled();
  });

  it('a provider-limit final message never goes quiet', async () => {
    await runToIdle("You've hit your session limit · resets 6:30pm (Europe/London)");

    expect(store.terminalizeRun).toHaveBeenCalledWith(
      'run-1', 'failed', expect.stringMatching(/^provider_limit:/), expect.anything(), expect.anything(),
    );
    expect(checkStoreMocks.setRunOutcome).not.toHaveBeenCalled();
    expect(store.markSeen).not.toHaveBeenCalled();
  });

  it('a failed run whose last reply ends in the sentinel never goes quiet', async () => {
    const instance = {
      id: 'i-failed',
      outputBuffer: [{ type: 'assistant', content: `Nothing to report.\n${QUIET_RUN_SENTINEL}`, timestamp: 1 }],
      status: 'working',
      metadata: {},
    };
    manager.createInstance.mockResolvedValue(instance);
    const runner = new AutomationRunner(store, getAutomationEvents(), () => 2_000, vi.fn());
    runner.initialize(manager);
    await runner.fire('automation-1', { trigger: 'scheduled', scheduledAt: 2_000 });

    manager.emit('instance:event', {
      instanceId: 'i-failed',
      event: { kind: 'status_changed', status: 'error' },
    });

    expect(store.terminalizeRun).toHaveBeenCalledWith(
      'run-1', 'failed', 'Instance entered error', expect.anything(), expect.anything(),
    );
    expect(checkStoreMocks.setRunOutcome).not.toHaveBeenCalled();
    expect(store.markSeen).not.toHaveBeenCalled();
  });
});
