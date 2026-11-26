import { describe, expect, it } from 'vitest';
import { LoopRunSummarySchema, LoopStateSchema } from '@contracts/schemas/loop';
import { defaultLoopConfig } from '../../../../shared/types/loop.types';
import { LoopPastRunsPanelComponent } from '../../features/loop/loop-past-runs-panel.component';
import { loopStateToRunSummary } from './loop-store-recent-runs';

function terminalState(endEvidence?: Record<string, unknown>) {
  return LoopStateSchema.parse({
    id: 'loop-evidence', chatId: 'chat-evidence', status: 'completed-needs-review',
    config: defaultLoopConfig('/fixture', 'Review the project'), currentStage: 'IMPLEMENT',
    totalIterations: 2, totalTokens: 0, totalCostCents: 0, startedAt: 100, endedAt: 200,
    endReason: 'The result needs review', endEvidence,
    pendingInterventions: [], completedFileRenameObserved: false,
    doneSentinelPresentAtStart: false, planChecklistFullyCheckedAtStart: false,
    tokensSinceLastTestImprovement: 0, highestTestPassCount: 0,
    iterationsOnCurrentStage: 0, recentWarnIterationSeqs: [],
    worktreeLifecycle: { phase: 'preserved', baseBranch: 'main', sessionBranch: 'loop/evidence', updatedAt: 200 },
  });
}

describe('live loop run summary end evidence', () => {
  it.each(['stalled', 'final-audit-blocked', 'verified-no-change'])('retains the %s hold when projecting live state', mergeHoldKind => {
    const endEvidence = { mergeHold: true, mergeHoldKind };
    expect(loopStateToRunSummary(terminalState(endEvidence))).toHaveProperty('endEvidence', endEvidence);
  });

  it('accepts a live terminal state without end evidence', () => {
    expect(loopStateToRunSummary(terminalState()).endEvidence).toBeUndefined();
  });

  it('uses persisted no-change evidence to describe the history row accurately', () => {
    const live = loopStateToRunSummary(terminalState({ mergeHold: true, mergeHoldKind: 'verified-no-change' }));
    const stored = LoopRunSummarySchema.parse(live);
    const presenter = LoopPastRunsPanelComponent.prototype as unknown as { endLine(run: typeof stored): string };
    expect(presenter.endLine(stored)).toBe('Ended · see notes. Nothing was merged because the loop made no production changes and needs your review. Merge it when you have looked. The work is on branch loop/evidence.');
  });
});
