import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultLoopConfig, type LoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import { PREFLIGHT_VERIFY_SKIPPED_NO_CHEAP_NOTE, runLoopFinalAudit, runLoopPreflight } from './loop-audit-runtime';
import { captureLoopRepoBaseline } from './loop-repo-state';
import { LoopStageMachine } from './loop-stage-machine';

const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const maybe = gitOk ? it : it.skip;

describe('runLoopPreflight', () => {
  it('reports the actual full verify execution to the supplied ledger callback before returning', async () => {
    const state = makeLoopState({
      id: 'loop-preflight-ledger',
      config: {
        ...defaultLoopConfig('/workspace', 'verify before work'),
        completion: {
          ...defaultLoopConfig('/workspace', 'verify before work').completion,
          verifyCommand: 'npm test',
        },
      },
    });
    const executions: unknown[] = [];

    const result = await runLoopPreflight(
      state,
      {
        runQuickVerify: async () => ({ status: 'skipped', output: '', durationMs: 0 }),
        runVerify: async () => ({ status: 'passed', output: 'all green', durationMs: 12 }),
      },
      (execution) => executions.push(execution),
    );

    expect(result.status).toBe('passed');
    expect(executions).toEqual([expect.objectContaining({
      label: 'verify',
      command: 'npm test',
      output: 'all green',
      exitCode: 0,
      durationMs: 12,
    })]);
  });

  // Regression: the result type collapsed every failure to `status: 'failed'`,
  // so a verify command that could not finish inside `verifyTimeoutMs` was
  // reported identically to one whose tests were red. Those need opposite fixes.
  it('carries the timeout failure kind through so a blown time budget is not reported as a red build', async () => {
    const state = makeLoopState({
      id: 'loop-preflight-timeout',
      config: {
        ...defaultLoopConfig('/workspace', 'verify before work'),
        completion: {
          ...defaultLoopConfig('/workspace', 'verify before work').completion,
          verifyCommand: 'npm run verify',
        },
      },
    });

    const result = await runLoopPreflight(state, {
      runQuickVerify: async () => ({ status: 'skipped', output: '', durationMs: 0 }),
      runVerify: async () => ({
        status: 'failed',
        output: '(verify timed out after 600000ms)',
        durationMs: 599_998,
        exitCode: null,
        failureKind: 'timeout',
      }),
    });

    expect(result.status).toBe('failed');
    expect(result.commands).toEqual([expect.objectContaining({
      label: 'verify',
      failureKind: 'timeout',
    })]);
  });

  // Regression: `record` mode gates nothing, yet it was awaited before
  // iteration 0 with the full `verifyTimeoutMs`. A repo whose verify runs the
  // whole suite spent the entire 600s budget producing "timed out" before the
  // agent had taken a single turn. The 180s cap (LT-531) still timed out on
  // this workspace when no cheap command was configured (LT-532), so record
  // mode now skips the slow command instead of running it.
  it('does not run the full verify when the preflight is not a gate and no cheap command ran', async () => {
    let verifyRuns = 0;
    const detector = {
      runQuickVerify: async () => ({ status: 'skipped' as const, output: '', durationMs: 0 }),
      runVerify: async () => {
        verifyRuns += 1;
        return { status: 'passed' as const, output: 'green', durationMs: 5 };
      },
    };

    const result = await runLoopPreflight(
      makeLoopState({ config: preflightState('record', 600_000) }),
      detector,
    );
    expect(verifyRuns).toBe(0);
    expect(result.status).toBe('skipped');
    expect(result.commands).toEqual([expect.objectContaining({
      label: 'verify',
      status: 'skipped',
      outputExcerpt: PREFLIGHT_VERIFY_SKIPPED_NO_CHEAP_NOTE,
    })]);

    const shortBudget = await runLoopPreflight(
      makeLoopState({ config: preflightState('record', 30_000) }),
      detector,
    );
    expect(verifyRuns).toBe(0);
    expect(shortBudget.status).toBe('skipped');
  });

  it('keeps the configured verify budget when the preflight is a gate', async () => {
    const seen: number[] = [];
    const detector = {
      runQuickVerify: async () => ({ status: 'skipped' as const, output: '', durationMs: 0 }),
      runVerify: async (config: LoopConfig) => {
        seen.push(config.completion.verifyTimeoutMs);
        return { status: 'passed' as const, output: 'green', durationMs: 5 };
      },
    };

    await runLoopPreflight(makeLoopState({ config: preflightState('block', 600_000) }), detector);
    expect(seen).toEqual([600_000]);

    seen.length = 0;
    await runLoopPreflight(makeLoopState({ config: preflightState('block', 30_000) }), detector);
    expect(seen).toEqual([30_000]);

    seen.length = 0;
    await runLoopPreflight(makeLoopState({ config: preflightState('record', 600_000) }), detector);
    expect(seen).toEqual([]);
  });

  // Regression: a `record` preflight ran the cheap command and THEN the slow
  // one, so a repo configured with both still paid the full baseline cost ahead
  // of iteration 1 — to produce a status nothing downstream reads.
  it('stops after a passing quick-verify when the preflight is not a gate', async () => {
    let verifyRuns = 0;
    const detector = {
      runQuickVerify: async () => ({ status: 'passed' as const, output: 'quick green', durationMs: 3 }),
      runVerify: async () => {
        verifyRuns += 1;
        return { status: 'passed' as const, output: 'slow green', durationMs: 500 };
      },
    };
    const base = preflightState('record', 600_000);
    const config: LoopConfig = {
      ...base,
      completion: { ...base.completion, quickVerifyCommand: 'npm run typecheck' },
    };

    const result = await runLoopPreflight(makeLoopState({ config }), detector);

    expect(verifyRuns).toBe(0);
    expect(result.status).toBe('passed');
    expect(result.commands.map((command) => [command.label, command.status])).toEqual([
      ['quick-verify', 'passed'],
      ['verify', 'skipped'],
    ]);

    // A gate still runs the command it gates on.
    await runLoopPreflight(
      makeLoopState({ config: { ...config, audit: { ...config.audit, preflightMode: 'block' } } }),
      detector,
    );
    expect(verifyRuns).toBe(1);
  });

  it('records a non-zero exit as a command failure, not a timeout', async () => {
    const state = makeLoopState({
      id: 'loop-preflight-command-failure',
      config: {
        ...defaultLoopConfig('/workspace', 'verify before work'),
        completion: {
          ...defaultLoopConfig('/workspace', 'verify before work').completion,
          verifyCommand: 'npm test',
        },
      },
    });

    const result = await runLoopPreflight(state, {
      runQuickVerify: async () => ({ status: 'skipped', output: '', durationMs: 0 }),
      runVerify: async () => ({
        status: 'failed',
        output: '3 tests failed',
        durationMs: 4_000,
        exitCode: 1,
        failureKind: 'command',
      }),
    });

    expect(result.commands[0]?.failureKind).toBe('command');
  });

  it('does not turn a passing preflight red when ledger reporting fails', async () => {
    const state = makeLoopState({
      config: {
        ...defaultLoopConfig('/workspace', 'verify before work'),
        completion: {
          ...defaultLoopConfig('/workspace', 'verify before work').completion,
          verifyCommand: 'npm test',
        },
      },
    });

    await expect(runLoopPreflight(
      state,
      {
        runQuickVerify: async () => ({ status: 'skipped', output: '', durationMs: 0 }),
        runVerify: async () => ({ status: 'passed', output: 'all green', durationMs: 12 }),
      },
      () => { throw new Error('ledger unavailable'); },
    )).resolves.toMatchObject({ status: 'passed' });
  });
});

describe('runLoopFinalAudit', () => {
  it('short-circuits as skipped when final audit mode is off', async () => {
    const config = {
      ...defaultLoopConfig('/tmp/project', 'ship it'),
      audit: {
        finalAuditMode: 'off' as const,
        preflightMode: 'off' as const,
        planPacketMode: 'off' as const,
        cleanlinessScan: true,
      },
    };
    const state: LoopState = {
      id: 'loop-audit-off',
      chatId: 'chat-1',
      config,
      status: 'running',
      startedAt: 1_700_000_000_000,
      endedAt: null,
      totalIterations: 0,
      totalTokens: 0,
      totalCostCents: 0,
      currentStage: 'IMPLEMENT',
      repoBaseline: {
        source: 'none',
        capturedAt: 1_700_000_000_000,
        workspaceCwd: config.workspaceCwd,
        headRef: null,
        dirtyAtStart: false,
        trackedDirtyAtStart: [],
        untrackedAtStart: [],
      },
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
    const iteration: LoopIteration = {
      id: 'loop-audit-off-0',
      loopRunId: state.id,
      seq: 0,
      stage: 'IMPLEMENT',
      startedAt: 1_700_000_001_000,
      endedAt: 1_700_000_002_000,
      childInstanceId: null,
      tokens: 0,
      costCents: 0,
      filesChanged: [],
      toolCalls: [],
      errors: [],
      testPassCount: null,
      testFailCount: null,
      workHash: 'hash',
      outputSimilarityToPrev: null,
      outputExcerpt: '',
      outputFull: '',
      progressVerdict: 'OK',
      progressSignals: [],
      completionSignalsFired: [],
      verifyStatus: 'passed',
      verifyOutputExcerpt: '',
    };
    const stageMachine = {
      paths: resolveLoopArtifactPaths(config.workspaceCwd, state.id),
      readTaskLedger: async () => {
        throw new Error('ledger should not be read when final audit is off');
      },
    } as unknown as LoopStageMachine;

    const result = await runLoopFinalAudit(state, iteration, 'passed', stageMachine);

    expect(result.status).toBe('skipped');
    expect(result.findings).toEqual([]);
    expect(result.coverage).toEqual({
      criteriaTotal: 0,
      criteriaVerified: 0,
      criteriaUnverified: 0,
      verifyCommandRan: false,
      repoComparisonRan: false,
      cleanlinessScanRan: false,
    });
    expect(result.reportPath).toBeUndefined();
    expect(iteration.finalAudit).toEqual(result);
    expect(state.latestFinalAudit).toEqual(result);
  });

  maybe('requires review when prompted plan-packet artifacts are missing', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'loop-audit-runtime-'));
    try {
      initGitRepo(workspace);
      const config = {
        ...defaultLoopConfig(workspace, 'ship it'),
        audit: {
          finalAuditMode: 'gate' as const,
          preflightMode: 'off' as const,
          planPacketMode: 'prompted' as const,
          cleanlinessScan: true,
        },
      };
      const stageMachine = new LoopStageMachine(workspace, 'loop-missing-packet');
      await stageMachine.bootstrap(config);
      const state = makeLoopState({
        id: 'loop-missing-packet',
        config,
        repoBaseline: captureLoopRepoBaseline(workspace),
      });
      mkdirSync(join(workspace, 'src'), { recursive: true });
      writeFileSync(join(workspace, 'src', 'feature.ts'), 'export const feature = true;\n', 'utf8');
      const iteration = makeLoopIteration({
        id: 'loop-missing-packet-0',
        loopRunId: state.id,
        verifyStatus: 'passed',
      });

      const result = await runLoopFinalAudit(state, iteration, 'passed', stageMachine);

      expect(result.status).toBe('needs-review');
      expect(result.findings).toContainEqual(expect.objectContaining({
        code: 'plan-criteria-unproven',
      }));
      expect(result.changedFiles).toContain('src/feature.ts');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function preflightState(
  preflightMode: LoopConfig['audit']['preflightMode'],
  verifyTimeoutMs: number,
): LoopConfig {
  const base = defaultLoopConfig('/workspace', 'verify before work');
  return {
    ...base,
    audit: { ...base.audit, preflightMode },
    completion: { ...base.completion, verifyCommand: 'npm run verify', verifyTimeoutMs },
  };
}

function makeLoopState(overrides: Partial<LoopState>): LoopState {
  const config = overrides.config ?? defaultLoopConfig('/tmp/project', 'ship it');
  return {
    id: 'loop-audit',
    chatId: 'chat-1',
    config,
    status: 'running',
    startedAt: 1_700_000_000_000,
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
    ...overrides,
  };
}

function makeLoopIteration(overrides: Partial<LoopIteration>): LoopIteration {
  return {
    id: 'loop-audit-0',
    loopRunId: 'loop-audit',
    seq: 0,
    stage: 'IMPLEMENT',
    startedAt: 1_700_000_001_000,
    endedAt: 1_700_000_002_000,
    childInstanceId: null,
    tokens: 0,
    costCents: 0,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: 'hash',
    outputSimilarityToPrev: null,
    outputExcerpt: '',
    outputFull: '',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
    ...overrides,
  };
}

function initGitRepo(workspace: string): void {
  git(workspace, 'init', '-q');
  git(workspace, 'config', 'user.email', 'test@example.com');
  git(workspace, 'config', 'user.name', 'Test');
  git(workspace, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'init');
}

function git(workspace: string, ...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}
