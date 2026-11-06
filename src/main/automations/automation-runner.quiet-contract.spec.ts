/**
 * 8c — the quiet-reply contract reaches the real `initialPrompt`.
 *
 * `appendQuietReplyContract` is applied at the shared `createInstance` call in
 * `automation-runner.ts`, reached by both first attempts and retries.
 * Scheduled and catch-up runs on a new instance get the
 * reply instruction; manual, webhook and the other triggers do not, and thread
 * wake-ups and loops never reach `createInstance` at all. These tests drive the
 * real runner so losing the contract on either path fails them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type {
  AutomationConfigSnapshot,
  AutomationRun,
  AutomationTrigger,
} from '../../shared/types/automation.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { AutomationStore } from './automation-store';
import type { ThreadWakeupRunner } from './thread-wakeup-runner';
import { AutomationRunner } from './automation-runner';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import { QUIET_RUN_SENTINEL } from './automation-run-quiet';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/ai-orchestrator-test') },
}));

vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));

// Account routing has its own tests; these runs must not read real settings.
vi.mock('./automation-account-rules', () => ({ automationAccountPreferences: async () => undefined }));

vi.mock('../channels/channel-manager', () => ({
  getChannelManager: () => ({ getAdapter: vi.fn(), emitResponseSent: vi.fn() }),
}));

const loopDispatch = vi.hoisted(() => vi.fn());

// A loop-action run goes to the loop dispatcher, never to createInstance.
vi.mock('./automation-loop-run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./automation-loop-run')>()),
  AutomationLoopRunDispatcher: class {
    dispatch = loopDispatch;
    track = vi.fn();
  },
}));

const JOB_PROMPT = 'Check the leads panel';

function makeSnapshot(overrides: Partial<AutomationConfigSnapshot> = {}): AutomationConfigSnapshot {
  return {
    name: 'Leads watch',
    schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
    trigger: { kind: 'schedule' },
    missedRunPolicy: 'notify',
    concurrencyPolicy: 'skip',
    destination: { kind: 'newInstance' },
    action: { prompt: JOB_PROMPT, workingDirectory: '/repo/current' },
    ...overrides,
  };
}

function makeRun(trigger: AutomationTrigger, snapshot: AutomationConfigSnapshot): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    status: 'running',
    trigger,
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
    maxAttempts: 2,
    configSnapshot: snapshot,
  };
}

describe('AutomationRunner quiet-reply contract wiring (8c)', () => {
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
    // A retry is only dispatched while its run is still running.
    getRun: vi.fn(() => ({ status: 'running', automationId: 'automation-1', loopRunId: null })),
  } as unknown as AutomationStore;
  const manager = Object.assign(new EventEmitter(), {
    createInstance: vi.fn(),
    getInstance: vi.fn(),
    queueInstanceUpdate: vi.fn(),
  }) as unknown as InstanceManager & { createInstance: ReturnType<typeof vi.fn> };
  const fireThreadWakeup = vi.fn();

  function makeRunner(): AutomationRunner {
    const runner = new AutomationRunner(
      store,
      getAutomationEvents(),
      () => 2_000,
      () => ({ fireThreadWakeup } as unknown as ThreadWakeupRunner),
    );
    runner.initialize(manager);
    return runner;
  }

  /** First attempt: `fire` -> shared dispatch -> `createInstance`. */
  async function fireAs(
    trigger: AutomationTrigger,
    snapshot = makeSnapshot(),
  ): Promise<void> {
    const run = makeRun(trigger, snapshot);
    vi.mocked(store.get).mockResolvedValue({
      id: 'automation-1',
      enabled: true,
      active: true,
      workspaceId: '/repo/current',
      ...snapshot,
    } as never);
    vi.mocked(store.decideAndInsertRun).mockReturnValue({ kind: 'started', run });
    await makeRunner().fire('automation-1', { trigger, scheduledAt: 2_000 });
  }

  /** Retry attempt: `dispatchRetryRun` -> shared dispatch -> `createInstance`. */
  async function retryAs(
    trigger: AutomationTrigger,
    snapshot = makeSnapshot(),
  ): Promise<void> {
    await makeRunner().dispatchRetryRun({ ...makeRun(trigger, snapshot), attempt: 2 });
  }

  const paths = [
    ['first attempt', fireAs],
    ['retry attempt', retryAs],
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAutomationEventsForTesting();
    manager.removeAllListeners();
    manager.createInstance.mockResolvedValue({
      id: 'i-1',
      outputBuffer: [],
      status: 'working',
      metadata: {},
    });
    fireThreadWakeup.mockImplementation(async ({ run }: { run: AutomationRun }) => ({
      ...run,
      status: 'succeeded',
    }));
    loopDispatch.mockResolvedValue(undefined);
    vi.mocked(store.claimNextPending).mockReturnValue(null);
    vi.mocked(store.failRunningRuns).mockReturnValue([]);
    vi.mocked(store.recordRunOutcome).mockReturnValue({ automation: null, autoDisabled: false });
    vi.mocked(store.attachInstance).mockImplementation((runId, instanceId) => (
      { ...makeRun('scheduled', makeSnapshot()), id: runId, instanceId }
    ));
    vi.mocked(store.terminalizeRun).mockImplementation((runId, status) => (
      { ...makeRun('scheduled', makeSnapshot()), id: runId, status }
    ));
  });

  function spawnedPrompt(): string {
    expect(manager.createInstance).toHaveBeenCalledTimes(1);
    return (manager.createInstance.mock.calls[0]![0] as { initialPrompt: string }).initialPrompt;
  }

  for (const [label, drive] of paths) {
    describe(label, () => {
      it.each(['scheduled', 'catchUp'] as const)(
        'a %s run gets the reply instruction appended after the job prompt',
        async (trigger) => {
          await drive(trigger);

          const prompt = spawnedPrompt();
          expect(prompt.startsWith(`${JOB_PROMPT}\n\n<harness_run_contract>`)).toBe(true);
          expect(prompt).toContain(`make the last line of your final reply exactly:\n${QUIET_RUN_SENTINEL}`);
          expect(prompt.endsWith('</harness_run_contract>')).toBe(true);
        },
      );

      it.each([
        'manual', 'webhook', 'channel', 'providerRuntime', 'orchestrationEvent',
      ] as const)('a %s run keeps the job prompt exactly as written', async (trigger) => {
        await drive(trigger);

        expect(spawnedPrompt()).toBe(JOB_PROMPT);
      });

      it('a scheduled thread wake-up never spawns an instance and carries no contract', async () => {
        const threadSnapshot = makeSnapshot({
          destination: { kind: 'thread', instanceId: 'i-target', reviveIfArchived: false },
        });

        await drive('scheduled', threadSnapshot);

        expect(manager.createInstance).not.toHaveBeenCalled();
        expect(fireThreadWakeup).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(fireThreadWakeup.mock.calls[0]![0])).not.toContain('harness_run_contract');
      });
    });
  }

  // Loop runs are never retried (automation-loop-run.ts hands every terminal back
  // as retryable:false), so only the first-attempt path can see a loop snapshot.
  it('a scheduled loop run goes to the loop dispatcher, not createInstance, with no contract', async () => {
    const loopSnapshot = makeSnapshot({
      action: {
        prompt: JOB_PROMPT,
        workingDirectory: '/repo/current',
        loop: { verifyCommand: 'npm test' },
      },
    });

    await fireAs('scheduled', loopSnapshot);

    expect(manager.createInstance).not.toHaveBeenCalled();
    expect(loopDispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loopDispatch.mock.calls[0]![0])).not.toContain('harness_run_contract');
  });
});
