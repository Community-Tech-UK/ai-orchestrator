/**
 * Fable WS5 Task 4 — spawn-loop automation action.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaimedAutomationRun, AutomationRun } from '../../shared/types/automation.types';
import {
  AutomationLoopRunDispatcher,
  automationLoopChatId,
  buildAutomationLoopConfig,
  type AutomationLoopRunDeps,
} from './automation-loop-run';
import { recordCostAttribution } from '../core/system/cost-attribution';
import { automationInvocations } from './automation-invocation-context';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
afterEach(() => vi.useRealTimers());

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
  let processed = 0;
  return {
    store: {
      getRunFacts: () => ({ result: { outcome: 'done', notify: true } }),
      recordStopFailure: vi.fn(),
      addProcessedUsage: (_runId, _instanceId, _source, tokens) => { processed += tokens; return processed; },
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
  it('keeps a resident invocation usable across an ordinary pause, then revokes it at end', async () => {
    const deps = makeDeps(); const dispatcher = await startTracked(deps);
    automationInvocations.configure(id => id);
    const scope = automationInvocations.prepare({ workingDirectory: '/repo', instanceId: automationLoopChatId('auto-1', 'run-1') }, 'claude')!;
    scope.bind({ terminate: vi.fn(async () => undefined) } as unknown as CliAdapter);
    const callerId = scope.options.mcpConfig![0];
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'paused' } });
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'running' } });
    expect(automationInvocations.get(callerId)?.runId).toBe('run-1');
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'completed' } });
    expect(automationInvocations.get(callerId)).toBeUndefined();
  });
  it('a sign-off pause fails its automation once while an ordinary pause stays live', () => {
    const deps = makeDeps();
    const dispatcher = new AutomationLoopRunDispatcher(deps);
    dispatcher.track('sign-off', makeRun({ id: 'run-1', automationId: 'auto-1' }));
    dispatcher.handleLoopStateChanged({ loopRunId: 'sign-off', state: { status: 'paused' } });
    expect(deps.onTerminal).not.toHaveBeenCalled();
    dispatcher.handleLoopStateChanged({ loopRunId: 'sign-off', state: { status: 'paused', lastCompletionOutcome: 'unverifiable' } });
    expect(deps.store.terminalizeRun).toHaveBeenCalledWith('run-1', 'failed', expect.stringContaining('Loop paused for sign-off'), undefined,
      { now: 1000, outputFullRef: undefined, monitorOutput: undefined });
    dispatcher.handleLoopStateChanged({ loopRunId: 'sign-off', state: { status: 'completed' } });
    expect(deps.onTerminal).toHaveBeenCalledTimes(1);
    expect(deps.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }), { retryable: false });
  });
  it('failed steps and ended provider limits fail the automation, parked limits stay live', () => {
    const deps = makeDeps(); const dispatcher = new AutomationLoopRunDispatcher(deps);
    dispatcher.track('limit', makeRun({ id: 'run-1', automationId: 'auto-1' }));
    dispatcher.handleLoopStateChanged({ loopRunId: 'limit', state: { status: 'provider-limit', endedAt: null } });
    expect(deps.onTerminal).not.toHaveBeenCalled();
    dispatcher.handleLoopStateChanged({ loopRunId: 'limit', state: { status: 'provider-limit', endedAt: 1000 } });
    expect(deps.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }), { retryable: false });
    dispatcher.track('step', makeRun({ id: 'run-2', automationId: 'auto-1' }));
    dispatcher.handleLoopStateChanged({ loopRunId: 'step', state: { status: 'attempt-failed' } });
    expect(deps.onTerminal).toHaveBeenCalledTimes(2);
  });
  async function startTracked(deps: ReturnType<typeof makeDeps>): Promise<AutomationLoopRunDispatcher> {
    const dispatcher = new AutomationLoopRunDispatcher(deps);
    await dispatcher.dispatch(makeClaimed());
    return dispatcher;
  }

  it('maps loop completed → succeeded (final, no retry)', async () => {
    const deps = makeDeps();
    const dispatcher = await startTracked(deps);
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'completed' } });
    expect(deps.store.terminalizeRun).toHaveBeenCalledWith('run-1', 'succeeded', undefined, 'Loop completed.',
      { now: 1_000, outputFullRef: undefined, monitorOutput: undefined });
    expect(deps.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }), { retryable: false });
  });

  it('maps completed-needs-review → succeeded with a review note', async () => {
    const deps = makeDeps();
    const dispatcher = await startTracked(deps);
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'completed-needs-review' } });
    expect(deps.store.terminalizeRun).toHaveBeenCalledWith(
      'run-1', 'succeeded', undefined, expect.stringContaining('check its notes'),
      { now: 1_000, outputFullRef: undefined, monitorOutput: undefined },
    );
  });

  it('maps a failing terminal loop → failed and feeds the breaker (retryable false)', async () => {
    const deps = makeDeps();
    const dispatcher = await startTracked(deps);
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'cap-reached' } });
    expect(deps.store.terminalizeRun).toHaveBeenCalledWith(
      'run-1', 'failed', 'Loop ended cap-reached', undefined,
      { now: 1_000, outputFullRef: undefined, monitorOutput: undefined },
    );
    expect(deps.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }), { retryable: false });
  });

  it('fails an unreplayable attempt once and never retries the whole loop', async () => {
    const deps = makeDeps();
    const dispatcher = await startTracked(deps);
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'attempt-failed', endedAt: 500 } });
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'attempt-failed', endedAt: 500 } });
    expect(deps.store.terminalizeRun).toHaveBeenCalledOnce();
    expect(deps.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }), { retryable: false });
  });

  it('keeps tracking a provider-limit park and fails when that same state ends', async () => {
    const deps = makeDeps();
    const dispatcher = await startTracked(deps);
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'provider-limit', endedAt: null } });
    expect(deps.store.terminalizeRun).not.toHaveBeenCalled();
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'provider-limit', endedAt: 500 } });
    expect(deps.store.terminalizeRun).toHaveBeenCalledWith('run-1', 'failed', 'Loop ended provider-limit', undefined,
      { now: 1_000, outputFullRef: undefined, monitorOutput: undefined });
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
  it('fails an empty completed loop without a semantic result', async () => {
    const deps = makeDeps(); const dispatcher = new AutomationLoopRunDispatcher(deps);
    deps.store.getRunFacts = () => ({ result: null });
    await dispatcher.dispatch(makeClaimed());
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'completed' } });
    expect(deps.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'No result or assistant text was returned' }), { retryable: false });
  });

  it('track() re-arms a restored run so a recovered loop still resolves it', () => {
    const deps = makeDeps();
    const dispatcher = new AutomationLoopRunDispatcher(deps);
    dispatcher.track('loop-run-77', makeRun({ id: 'run-2', automationId: 'auto-1' }));
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-77', state: { status: 'completed' } });
    expect(deps.store.terminalizeRun).toHaveBeenCalledWith('run-2', 'succeeded', undefined, 'Loop completed.',
      { now: 1_000, outputFullRef: undefined, monitorOutput: undefined });
  });
});

describe('scheduled loop run limits', () => {
  it('retains failed loop stops, retries cancellation and never terminalizes again', async () => {
    vi.useFakeTimers(); let now = 1000;
    const cancelLoop = vi.fn().mockRejectedValueOnce(new Error('stop failed')).mockResolvedValue(undefined);
    const deps = makeDeps({ now: () => now, cancelLoop }); const dispatcher = new AutomationLoopRunDispatcher(deps);
    const claimed = makeClaimed(); claimed.snapshot.action.maxRunMinutes = 1;
    await dispatcher.dispatch(claimed); now = 61_001;
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'completed' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.store.recordStopFailure).toHaveBeenCalledWith('run-1');
    await vi.advanceTimersByTimeAsync(5000);
    expect(cancelLoop).toHaveBeenCalledTimes(2);
    expect(deps.onTerminal).toHaveBeenCalledOnce();
  });
  it('cancels an overdue loop before accepting its late completion', async () => {
    vi.useFakeTimers();
    let now = 1000;
    const cancelled: string[] = [];
    const deps = makeDeps({ now: () => now, cancelLoop: async id => { cancelled.push(id); } });
    const dispatcher = new AutomationLoopRunDispatcher(deps);
    const claimed = makeClaimed(); claimed.run.startedAt = 1000;
    const action = { ...claimed.snapshot.action, maxRunMinutes: 1 }; claimed.snapshot.action = action;
    await dispatcher.dispatch(claimed);
    now = 61_001;
    dispatcher.handleLoopStateChanged({ loopRunId: 'loop-run-9', state: { status: 'completed' } });
    await Promise.resolve();
    expect(deps.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'Stopped after 1 minutes' }), { retryable: false });
    expect(cancelled).toEqual(['loop-run-9']);
    expect(deps.onTerminal).toHaveBeenCalledTimes(1);
  });
  it('counts loop-correlated input and both caches, then cancels without retry', async () => {
    vi.useFakeTimers();
    const cancelled: string[] = [];
    const deps = makeDeps({ cancelLoop: async id => { cancelled.push(id); } });
    const dispatcher = new AutomationLoopRunDispatcher(deps);
    const claimed = makeClaimed();
    const action = { ...claimed.snapshot.action, maxProcessedTokens: 100 }; claimed.snapshot.action = action;
    await dispatcher.dispatch(claimed);
    recordCostAttribution({ source: 'one-shot', taskType: 'loop', correlationId: 'loop-run-9::iteration::1', usage: { inputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 11 } });
    await Promise.resolve();
    expect(deps.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'Stopped: token cap' }), { retryable: false });
    expect(cancelled).toEqual(['loop-run-9']);
  });
});
