/**
 * Fable WS5 Task 4 — spawn-loop automation action.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ClaimedAutomationRun, AutomationRun } from '../../shared/types/automation.types';
import {
  AutomationLoopRunDispatcher,
  automationLoopChatId,
  buildAutomationLoopConfig,
  type AutomationLoopRunDeps,
} from './automation-loop-run';

function makeRun(over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    status: 'running',
    trigger: 'webhook',
    scheduledAt: 1,
    startedAt: 1,
    finishedAt: null,
    instanceId: null,
    loopRunId: null,
    error: null,
    outputSummary: null,
    outputFullRef: null,
    idempotencyKey: 'delivery-1',
    triggerSource: null,
    deliveryMode: 'notify',
    seenAt: null,
    createdAt: 1,
    updatedAt: 1,
    configSnapshot: null,
    attempt: 1,
    maxAttempts: 1,
    ...over,
  };
}

function makeClaimed(loopOver: Record<string, unknown> = {}): ClaimedAutomationRun {
  const run = makeRun();
  return {
    run,
    automation: { id: 'auto-1' } as ClaimedAutomationRun['automation'],
    snapshot: {
      name: 'Fix reported issue',
      schedule: { type: 'cron', expression: '0 0 * * *', timezone: 'UTC' },
      trigger: { kind: 'webhook', routeId: 'route-1', filters: [] },
      missedRunPolicy: 'skip',
      concurrencyPolicy: 'skip',
      destination: { kind: 'newInstance' },
      action: {
        prompt: 'Fix issue #42: widget crashes on empty config',
        workingDirectory: '/repo',
        provider: 'codex',
        loop: {
          verifyCommand: 'npm test',
          maxIterations: 5,
          maxCostCents: 500,
          ...loopOver,
        },
      },
    },
  };
}

function makeDeps(over: Partial<AutomationLoopRunDeps> = {}): AutomationLoopRunDeps & {
  onTerminal: ReturnType<typeof vi.fn>;
} {
  const terminalized: AutomationRun[] = [];
  return {
    store: {
      attachLoopRun: vi.fn((runId: string, loopRunId: string) => makeRun({ id: runId, loopRunId })),
      terminalizeRun: vi.fn((runId: string, status: 'succeeded' | 'failed' | 'skipped' | 'cancelled', error?: string, outputSummary?: string) => {
        const run = makeRun({ id: runId, status, error: error ?? null, outputSummary: outputSummary ?? null });
        terminalized.push(run);
        return run;
      }),
    },
    now: () => 1_000,
    onTerminal: vi.fn(),
    startLoop: vi.fn(async () => ({ id: 'loop-run-9' })),
    prepareConfig: vi.fn(async (config) => config),
    subscribeLoopStateChanged: vi.fn(),
    ...over,
  } as AutomationLoopRunDeps & { onTerminal: ReturnType<typeof vi.fn> };
}

describe('buildAutomationLoopConfig', () => {
  it('carries the goal, verify authority, caps, provider, and defaults isolation ON', () => {
    const config = buildAutomationLoopConfig(makeClaimed());
    expect(config.initialPrompt).toBe('Fix issue #42: widget crashes on empty config');
    expect(config.workspaceCwd).toBe('/repo');
    expect(config.provider).toBe('codex');
    expect(config.completion?.verifyCommand).toBe('npm test');
    expect(config.isolateLoopWorkspaces).toBe(true);
    expect(config.caps?.maxIterations).toBe(5);
    expect(config.caps?.maxCostCents).toBe(500);
  });

  it('honours an explicit isolateWorkspace=false and loopRecipe', () => {
    const config = buildAutomationLoopConfig(makeClaimed({ isolateWorkspace: false, loopRecipe: 'coding' }));
    expect(config.isolateLoopWorkspaces).toBe(false);
    expect((config as { loopRecipe?: string }).loopRecipe).toBe('coding');
  });
});

describe('AutomationLoopRunDispatcher.dispatch', () => {
  it('prepares (WS6 gates), starts the loop under a synthetic automation chat root, and links the loop run', async () => {
    const deps = makeDeps();
    const dispatcher = new AutomationLoopRunDispatcher(deps);
    await dispatcher.dispatch(makeClaimed());

    expect(deps.prepareConfig).toHaveBeenCalledOnce();
    expect(deps.startLoop).toHaveBeenCalledWith(
      automationLoopChatId('auto-1', 'run-1'),
      expect.objectContaining({ initialPrompt: expect.stringContaining('issue #42') }),
    );
    expect(deps.store.attachLoopRun).toHaveBeenCalledWith('run-1', 'loop-run-9', 1_000);
    expect(deps.onTerminal).not.toHaveBeenCalled();
  });

  it('terminalizes as a NON-retryable failure when the WS6 policy refuses the config', async () => {
    const deps = makeDeps({
      prepareConfig: vi.fn(async () => { throw new Error('implementation loop requires a verify command'); }),
    });
    const dispatcher = new AutomationLoopRunDispatcher(deps);
    await dispatcher.dispatch(makeClaimed());

    expect(deps.startLoop).not.toHaveBeenCalled();
    expect(deps.store.terminalizeRun).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.stringContaining('verify command'),
      undefined,
      1_000,
    );
    expect(deps.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }), { retryable: false });
  });
});

describe('AutomationLoopRunDispatcher terminal resolution', () => {
  async function startTracked(deps: ReturnType<typeof makeDeps>): Promise<AutomationLoopRunDispatcher> {
    const dispatcher = new AutomationLoopRunDispatcher(deps);
    await dispatcher.dispatch(makeClaimed());
    return dispatcher;
  }

  it('maps loop completed → succeeded (final, no retry)', async () => {
    const deps = makeDeps();
    const dispatcher = await startTracked(deps);
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'completed' } });
    expect(deps.store.terminalizeRun).toHaveBeenCalledWith('run-1', 'succeeded', undefined, 'Loop completed.', 1_000);
    expect(deps.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }), { retryable: false });
  });

  it('maps completed-needs-review → succeeded with a review note', async () => {
    const deps = makeDeps();
    const dispatcher = await startTracked(deps);
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'completed-needs-review' } });
    expect(deps.store.terminalizeRun).toHaveBeenCalledWith(
      'run-1', 'succeeded', undefined, expect.stringContaining('human review'), 1_000,
    );
  });

  it('maps a failing terminal loop → failed and feeds the breaker (retryable false)', async () => {
    const deps = makeDeps();
    const dispatcher = await startTracked(deps);
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'cap-reached' } });
    expect(deps.store.terminalizeRun).toHaveBeenCalledWith(
      'run-1', 'failed', 'Loop ended cap-reached', undefined, 1_000,
    );
    expect(deps.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }), { retryable: false });
  });

  it('ignores non-terminal states and untracked loop runs; resolves each run once', async () => {
    const deps = makeDeps();
    const dispatcher = await startTracked(deps);
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'paused' } });
    dispatcher.handleLoopStateChanged({ loopRunId: 'other-loop', state: { status: 'completed' } });
    expect(deps.store.terminalizeRun).not.toHaveBeenCalled();

    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'completed' } });
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'failed' } });
    expect(deps.store.terminalizeRun).toHaveBeenCalledTimes(1);
  });

  it('track() re-arms a restored run so a recovered loop still resolves it', () => {
    const deps = makeDeps();
    const dispatcher = new AutomationLoopRunDispatcher(deps);
    dispatcher.track('loop-run-77', 'run-2', 'auto-1');
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-77', state: { status: 'completed' } });
    expect(deps.store.terminalizeRun).toHaveBeenCalledWith('run-2', 'succeeded', undefined, 'Loop completed.', 1_000);
  });
});
