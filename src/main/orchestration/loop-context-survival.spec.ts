import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CompactionCoordinator } from '../context/compaction-coordinator';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';
import {
  applyLoopContextSurvivalDecision,
  defaultLoopContextSurvivalManager,
  evaluatePostCompactionCanary,
} from './loop-context-survival';
import { createLoopPendingInput } from '../../shared/types/loop.types';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import type { LoopChildResult } from './loop-coordinator';

function makeState(id = 'loop-survival-1', workspaceCwd = '/tmp/aio-loop-context-survival'): LoopState {
  const config = defaultLoopConfig(workspaceCwd, 'finish the task');
  config.caps.maxTokens = 10_000;
  return {
    id,
    chatId: 'chat-1',
    config,
    status: 'running',
    startedAt: 0,
    endedAt: null,
    totalIterations: 0,
    totalTokens: 0,
    totalCostCents: 0,
    currentStage: 'IMPLEMENT',
    pendingInterventions: [],
    completedFileRenameObserved: false,
    doneSentinelPresentAtStart: false,
    planChecklistFullyCheckedAtStart: false,
    uncompletedPlanFilesAtStart: [],
    manualReviewOnly: false,
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    completionAttempts: 0,
    loopTasksLedgerResolvedAtStart: false,
  };
}

function makeIteration(tokens: number, sufficientCompletion = false): LoopIteration {
  return {
    id: `iter-${tokens}`,
    loopRunId: 'loop-survival-1',
    seq: 0,
    stage: 'IMPLEMENT',
    startedAt: 0,
    endedAt: 1,
    childInstanceId: null,
    tokens,
    costCents: 0,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: `hash-${tokens}`,
    outputSimilarityToPrev: null,
    outputExcerpt: 'iteration output',
    outputFull: 'iteration output',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: sufficientCompletion
      ? [{ id: 'declared-complete', sufficient: true, detail: 'agent declared done' }]
      : [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
  };
}

function makeChildResult(tokens: number): LoopChildResult {
  return {
    childInstanceId: null,
    output: 'iteration output',
    tokens,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

describe('evaluatePostCompactionCanary (B5)', () => {
  it('passes when the post-compaction turn produced a usable turn', () => {
    const result = evaluatePostCompactionCanary({ iterationVoid: false, workspaceAlive: false });
    expect(result.failed).toBe(false);
    expect(result.reason).toContain('usable turn');
  });

  it('fails when a void post-compaction turn coincides with a dead workspace', () => {
    const result = evaluatePostCompactionCanary({ iterationVoid: true, workspaceAlive: false });
    expect(result.failed).toBe(true);
    expect(result.reason).toContain('not wired');
  });

  it('does not fail (defers) when the turn was void but the workspace is responsive', () => {
    const result = evaluatePostCompactionCanary({ iterationVoid: true, workspaceAlive: true });
    expect(result.failed).toBe(false);
    expect(result.reason).toContain('responsive');
  });
});

describe('defaultLoopContextSurvivalManager', () => {
  afterEach(() => {
    CompactionCoordinator._resetForTesting();
  });

  it('returns a soft-floor nudge when a sufficient completion signal fires under budget', async () => {
    const state = makeState();
    const iteration = makeIteration(5_000, true);

    const decision = await defaultLoopContextSurvivalManager.onIterationSealed({
      state,
      iteration,
      childResult: makeChildResult(iteration.tokens),
    });

    expect(decision).toMatchObject({
      action: 'none',
      forceContextReset: false,
    });
    expect(decision.reason).toContain('completion signal fired under token target');
    expect(decision.nudge).toContain('Keep working');
  });

  it('keeps budget tracking isolated by loop id', async () => {
    const loopA = makeState('loop-a');
    const loopB = makeState('loop-b');

    await defaultLoopContextSurvivalManager.onIterationSealed({
      state: loopA,
      iteration: makeIteration(400),
      childResult: makeChildResult(400),
    });
    await defaultLoopContextSurvivalManager.onIterationSealed({
      state: loopB,
      iteration: makeIteration(700),
      childResult: makeChildResult(700),
    });

    const coordinator = CompactionCoordinator.getInstance();
    expect(coordinator.getBudgetTracker(loopA.id).getStats().continuations).toBe(1);
    expect(coordinator.getBudgetTracker(loopB.id).getStats().continuations).toBe(1);
  });

  describe('B5a rehydration after a context reset', () => {
    let cwd: string;

    function makeReset(childTokens: number, filesChanged: { path: string }[] = []): LoopChildResult {
      return {
        ...makeChildResult(childTokens),
        filesChanged: filesChanged.map((f) => ({
          path: f.path,
          additions: 1,
          deletions: 0,
          contentHash: 'hash',
        })),
        contextCompacted: { previousUtilization: 0.9, newUtilization: 0.1, reason: 'test recycle' },
      };
    }

    afterEach(async () => {
      if (cwd) await fsp.rm(cwd, { recursive: true, force: true });
    });

    it('populates rehydrate with the plan file, the ledger, and edited files, capped and deduped', async () => {
      cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'aio-loop-survival-'));
      const state = makeState('loop-rehydrate-1', cwd);
      state.config.planFile = 'PLAN.md';
      await fsp.writeFile(path.join(cwd, 'PLAN.md'), '# Plan\n', 'utf8');
      const tasksPath = resolveLoopArtifactPaths(cwd, state.id).tasks;
      await fsp.mkdir(path.dirname(tasksPath), { recursive: true });
      await fsp.writeFile(tasksPath, '- [ ] one\n', 'utf8');
      const editedAbs = path.join(cwd, 'src', 'foo.ts');

      const decision = await defaultLoopContextSurvivalManager.onIterationSealed({
        state,
        iteration: makeIteration(400),
        childResult: makeReset(400, [
          { path: 'src/foo.ts' },
          { path: 'src/foo.ts' }, // duplicate — must be deduped
          { path: 'src/bar.ts' },
          { path: 'src/baz.ts' },
          { path: 'src/qux.ts' },
          { path: 'src/over-cap.ts' },
        ]),
      });

      expect(decision.rehydrate).toBeDefined();
      expect(decision.rehydrate).toContain(path.join(cwd, 'PLAN.md'));
      expect(decision.rehydrate).toContain(tasksPath);
      expect(decision.rehydrate).toContain(editedAbs);
      // Capped at MAX_REHYDRATE_FILES (5): planFile + ledger + 3 unique edited files.
      expect(decision.rehydrate!.length).toBe(5);
      expect(decision.rehydrate).not.toContain(path.join(cwd, 'src', 'over-cap.ts'));
    });

    it('does not set rehydrate when no context reset happened this iteration', async () => {
      cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'aio-loop-survival-'));
      const state = makeState('loop-rehydrate-2', cwd);

      const decision = await defaultLoopContextSurvivalManager.onIterationSealed({
        state,
        iteration: makeIteration(400),
        childResult: makeChildResult(400), // no contextCompacted
      });

      expect(decision.rehydrate).toBeUndefined();
    });

    it('applyLoopContextSurvivalDecision loads rehydrate content into a queued pending input', async () => {
      cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'aio-loop-survival-'));
      const state = makeState('loop-rehydrate-3', cwd);
      state.config.planFile = 'PLAN.md';
      await fsp.writeFile(path.join(cwd, 'PLAN.md'), '# The Plan\ndo the thing\n', 'utf8');

      const iteration = makeIteration(400);
      const childResult = makeReset(400);

      await applyLoopContextSurvivalDecision({
        manager: defaultLoopContextSurvivalManager,
        state,
        iteration,
        childResult,
        pendingContextReset: new Set<string>(),
        emit: () => undefined,
      });

      expect(state.pendingInterventions).toHaveLength(1);
      const injected = state.pendingInterventions[0];
      expect(injected.kind).toBe('queue');
      expect(injected.source).toBe('context-survival');
      expect(injected.message).toContain('Restored working set');
      expect(injected.message).toContain('do the thing');
    });

    it('still rehydrates after a reset even when interventions are already queued (suppressNudge)', async () => {
      cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'aio-loop-survival-'));
      const state = makeState('loop-rehydrate-5', cwd);
      state.config.planFile = 'PLAN.md';
      await fsp.writeFile(path.join(cwd, 'PLAN.md'), '# The Plan\ndo the thing\n', 'utf8');
      // Operator already queued a hint for the next iteration.
      state.pendingInterventions.push(createLoopPendingInput('operator steer', { source: 'human' }));

      await applyLoopContextSurvivalDecision({
        manager: defaultLoopContextSurvivalManager,
        state,
        iteration: makeIteration(400, true), // sufficient completion → would nudge
        childResult: makeReset(400),
        pendingContextReset: new Set<string>(),
        emit: () => undefined,
        suppressNudge: true,
      });

      // The operator hint plus the rehydration note remain; NO budget nudge added.
      const messages = state.pendingInterventions.map((i) => i.message);
      expect(messages).toContain('operator steer');
      expect(messages.some((m) => m.includes('Restored working set'))).toBe(true);
      expect(messages.some((m) => m.includes('Keep working'))).toBe(false);
    });

    it('skips unreadable rehydrate paths without throwing and without injecting an empty note', async () => {
      cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'aio-loop-survival-'));
      const state = makeState('loop-rehydrate-4', cwd);
      // No PLAN.md, no LOOP_TASKS.md on disk — everything unreadable.
      state.config.planFile = 'PLAN.md';

      const iteration = makeIteration(400);
      const childResult = makeReset(400);

      await expect(
        applyLoopContextSurvivalDecision({
          manager: defaultLoopContextSurvivalManager,
          state,
          iteration,
          childResult,
          pendingContextReset: new Set<string>(),
          emit: () => undefined,
        }),
      ).resolves.not.toThrow();

      expect(state.pendingInterventions).toHaveLength(0);
    });
  });
});
