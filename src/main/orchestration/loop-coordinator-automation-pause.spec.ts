import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationLoopRunDispatcher, type AutomationLoopRunStorePort } from '../automations/automation-loop-run';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import type { AutomationRun } from '../../shared/types/automation.types';
import { CompletedFileWatcher } from './loop-completion-detector';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import { LoopPausedNoProgressEventSchema } from '@contracts/schemas/loop-events';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';

let workspace: string;
let coordinator: LoopCoordinator;
let dispatcher: AutomationLoopRunDispatcher;
let terminalizeRun: ReturnType<typeof vi.fn<AutomationLoopRunStorePort['terminalizeRun']>>;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-automation-pause-'));
  writeFileSync(join(workspace, 'package.json'), '{"name":"loop-automation-pause"}\n');
  vi.spyOn(CompletedFileWatcher.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompletedFileWatcher.prototype, 'stop').mockResolvedValue();
  vi.spyOn(CompletedFileWatcher.prototype, 'scanOnce').mockReturnValue(null);
  coordinator = new LoopCoordinator();
  terminalizeRun = vi.fn<AutomationLoopRunStorePort['terminalizeRun']>(() => null);
  dispatcher = new AutomationLoopRunDispatcher({
    store: {
      getRunFacts: () => ({ result: null }),
      recordStopFailure: vi.fn(),
      addProcessedUsage: () => 0,
      attachLoopRun: () => null,
      terminalizeRun,
    },
    now: () => 1000,
    onTerminal: vi.fn(),
    subscribeLoopStateChanged: (listener) => coordinator.on('loop:state-changed', listener),
  });
  coordinator.on('loop:started', ({ loopRunId }: { loopRunId: string }) => {
    dispatcher.track(loopRunId, automationRun());
  });
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) await coordinator.cancelLoop(loop.id);
  coordinator.removeAllListeners();
  vi.restoreAllMocks();
  rmSync(workspace, { recursive: true, force: true });
});

function automationRun(): AutomationRun {
  return {
    id: 'automation-run', automationId: 'automation', status: 'running', trigger: 'webhook', scheduledAt: 1, startedAt: 1,
    finishedAt: null, instanceId: null, loopRunId: null, error: null, outputSummary: null, outputFullRef: null,
    idempotencyKey: 'delivery-1', triggerSource: null, deliveryMode: 'notify', seenAt: null, createdAt: 1, updatedAt: 1,
    configSnapshot: null, attempt: 1, maxAttempts: 1,
  };
}

function config() {
  const base = defaultLoopConfig(workspace, 'continue the work');
  return {
    ...base,
    audit: { ...base.audit, preflightMode: 'off' as const, finalAuditMode: 'off' as const },
    blockSanityProbe: { enabled: false, timeoutMs: 1000 },
    caps: { ...base.caps, maxIterations: 5 },
    completion: {
      ...base.completion,
      mode: 'gated' as const,
      verifyCommand: '',
      allowOperatorReviewedCompletion: true,
      requireCompletedFileRename: false,
    },
  };
}

function iteration(output = 'still working'): LoopChildResult {
  return {
    childInstanceId: null, output, tokens: 1, filesChanged: [], toolCalls: [], errors: [],
    testPassCount: null, testFailCount: null, exitedCleanly: true,
  };
}

async function expectAttention(reason: string) {
  await vi.waitFor(() => expect(terminalizeRun).toHaveBeenCalledWith(
    'automation-run', 'needs-attention', expect.stringContaining(reason), undefined, expect.objectContaining({ now: 1000 }),
  ), { timeout: 3000 });
}

describe('LoopCoordinator pause reasons delivered to automations', () => {
  it('delivers the real BLOCKED.md reason through the bound file handler and state broadcast', async () => {
    coordinator.on('loop:invoke-iteration', ({ callback }: { callback: (result: LoopChildResult) => void }) => {
      writeFileSync(join(workspace, 'BLOCKED.md'), 'Waiting for the requested design decision');
      callback(iteration());
    });
    const state = await coordinator.startLoop('blocked-file', config());

    await expectAttention('BLOCKED.md present: Waiting for the requested design decision');
    expect(coordinator.getLoop(state.id)?.endReason)
      .toBe('BLOCKED.md present: Waiting for the requested design decision');
    expect(terminalizeRun).toHaveBeenCalledOnce();
  });

  it('delivers a structural no-progress reason without changing its event contract', async () => {
    const paused: unknown[] = [];
    coordinator.on('loop:paused-no-progress', (payload) => paused.push(payload));
    coordinator.on('loop:invoke-iteration', ({ callback }: { callback: (result: LoopChildResult) => void }) => callback(iteration()));
    const base = config();
    const state = await coordinator.startLoop('no-progress', {
      ...base,
      progressThresholds: { ...base.progressThresholds, pauseOnTokenBurn: true, tokensWithoutProgressCritical: 1 },
    });

    await expectAttention('1 tokens spent since last test improvement');
    expect(coordinator.getLoop(state.id)?.endReason).toContain('1 tokens spent since last test improvement');
    expect(LoopPausedNoProgressEventSchema.safeParse(paused[0]).success).toBe(true);
  });

  it('delivers the resource measurement instead of the event category', async () => {
    coordinator.setResourceGovernor(() => ({
      level: 'critical', actions: ['pause-loop'], reasons: ['rss-above-critical'],
    }));
    const state = await coordinator.startLoop('resource-pause', config());

    await expectAttention('Paused by resource governor: rss-above-critical');
    expect(coordinator.getLoop(state.id)?.endReason)
      .toBe('Paused by resource governor: rss-above-critical');
  });

  it('stores a factual manual reason and clears it before broadcasting Resume', async () => {
    coordinator.on('loop:invoke-iteration', () => undefined);
    const state = await coordinator.startLoop('manual-pause', config());
    expect(coordinator.pauseLoop(state.id)).toBe(true);

    await expectAttention('Paused by request');
    const runningReasons: (string | undefined)[] = [];
    coordinator.on('loop:state-changed', ({ state: changed }: { state: LoopState }) => {
      if (changed.status === 'running') runningReasons.push(changed.endReason);
    });
    expect(coordinator.resumeLoop(state.id)).toBe(true);
    expect(coordinator.getLoop(state.id)?.endReason).toBeUndefined();
    expect(runningReasons.at(-1)).toBeUndefined();
  });

  it('does not carry sign-off eligibility or its explanation into a later manual pause', async () => {
    let invocation = 0;
    coordinator.on('loop:invoke-iteration', ({ loopRunId, callback }: { loopRunId: string; callback: (result: LoopChildResult) => void }) => {
      if (invocation++ === 0) {
        const paths = resolveLoopArtifactPaths(workspace, loopRunId);
        mkdirSync(paths.dir, { recursive: true });
        writeFileSync(join(paths.dir, 'DONE.txt'), 'done\n');
        callback(iteration('<promise>DONE</promise>'));
      }
    });
    const state = await coordinator.startLoop('sign-off-resume', config());
    await vi.waitFor(() => expect(coordinator.getLoop(state.id)?.status).toBe('paused'), { timeout: 3000 });
    expect(coordinator.getLoop(state.id)?.lastCompletionOutcome).toBe('unverifiable');

    expect(coordinator.resumeLoop(state.id)).toBe(true);
    expect(coordinator.getLoop(state.id)?.lastCompletionOutcome).toBeUndefined();
    dispatcher.track(state.id, automationRun());
    terminalizeRun.mockClear();
    expect(coordinator.pauseLoop(state.id)).toBe(true);

    await expectAttention('Paused by request');
    expect(terminalizeRun.mock.calls[0][2]).not.toContain('sign-off');
    expect(await coordinator.acceptCompletion(state.id)).toBe(false);
  });
});
