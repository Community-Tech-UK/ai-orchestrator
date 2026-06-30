import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import { runLoopFinalAudit } from './loop-audit-runtime';
import { captureLoopRepoBaseline } from './loop-repo-state';
import { LoopStageMachine } from './loop-stage-machine';

const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const maybe = gitOk ? it : it.skip;

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
