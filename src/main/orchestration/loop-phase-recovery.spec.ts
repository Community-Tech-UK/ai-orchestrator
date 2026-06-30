import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoopFinalAuditResult, LoopState } from '../../shared/types/loop.types';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { applyLoopPhaseRecovery } from './loop-phase-recovery';
import { LoopStageMachine } from './loop-stage-machine';

const RUN_ID = 'phase-recovery-loop';

let tmpDir: string;
let stageMachine: LoopStageMachine;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-phase-recovery-'));
  stageMachine = new LoopStageMachine(tmpDir, RUN_ID);
  await stageMachine.bootstrap(defaultLoopConfig(tmpDir, 'finish phase one'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('applyLoopPhaseRecovery', () => {
  it('updates OUTSTANDING.md as a single two-section document on handoff', async () => {
    fs.writeFileSync(
      stageMachine.paths.tasks,
      '- [ ] Phase 1: prove the audit blocks completion\n',
      'utf8',
    );
    fs.writeFileSync(
      stageMachine.paths.outstanding,
      [
        '## Needs human',
        '- (none)',
        '',
        '## Open questions',
        '- Should audit gate mode be default?',
        '  - Recommendation: Keep observe mode until smoke-tested.',
        '',
      ].join('\n'),
      'utf8',
    );
    const state = minimalLoopState();
    const finalAudit = failedAudit();

    await applyLoopPhaseRecovery({ state, iteration: undefined, finalAudit, stageMachine });
    await applyLoopPhaseRecovery({ state, iteration: undefined, finalAudit, stageMachine });
    const decision = await applyLoopPhaseRecovery({ state, iteration: undefined, finalAudit, stageMachine });

    expect(decision.status).toBe('handoff');
    const outstanding = fs.readFileSync(stageMachine.paths.outstanding, 'utf8');
    expect(outstanding.match(/^## Needs human$/gm)).toHaveLength(1);
    expect(outstanding.match(/^## Open questions$/gm)).toHaveLength(1);
    expect(outstanding).toContain('Phase recovery handoff for phase-1');
    expect(outstanding).toContain('- Recommendation: Review');
    expect(outstanding).toContain('Should audit gate mode be default?');
    expect(outstanding).toContain('Keep observe mode until smoke-tested.');
  });
});

function minimalLoopState(): LoopState {
  const config = defaultLoopConfig(tmpDir, 'finish phase one');
  return {
    id: RUN_ID,
    chatId: 'chat-1',
    config,
    status: 'running',
    startedAt: Date.now(),
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

function failedAudit(): LoopFinalAuditResult {
  return {
    status: 'failed',
    ranAt: Date.now(),
    coverage: {
      criteriaTotal: 1,
      criteriaVerified: 0,
      criteriaUnverified: 1,
      verifyCommandRan: true,
      repoComparisonRan: true,
      cleanlinessScanRan: true,
    },
    findings: [
      {
        severity: 'blocking',
        code: 'ledger-open',
        message: 'LOOP_TASKS.md still has 1 open item.',
      },
    ],
    changedFiles: ['src/main/orchestration/loop-phase-recovery.ts'],
  };
}
