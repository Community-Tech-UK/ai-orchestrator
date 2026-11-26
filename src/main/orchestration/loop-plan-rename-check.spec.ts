import { describe, expect, it, vi } from 'vitest';
import { defaultCrossModelReviewConfig, defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';
import type { LoopCompletionDetector, VerifyOutcome } from './loop-completion-detector';
import { evaluateReviewDrivenCompletion } from './loop-coordinator-completion-gates';
import type { ReviewDrivenTerminal } from './loop-finish-phase';
import { applyReviewDrivenCompletionNotes } from './loop-plan-rename-check';
import type { LoopStageMachine } from './loop-stage-machine';

function fixture() {
  const config = defaultLoopConfig(process.cwd(), 'Finish the plan');
  config.planFile = 'example_plan.md';
  config.completion.requiredCleanReviewPasses = 1;
  config.completion.requireCompletedFileRename = true;
  config.completion.crossModelReview = { ...defaultCrossModelReviewConfig(), enabled: false };
  const state: LoopState = {
    id: 'plan-loop', chatId: 'chat', config, status: 'running', startedAt: 1, endedAt: null,
    totalIterations: 0, totalTokens: 0, totalCostCents: 0, currentStage: 'IMPLEMENT',
    pendingInterventions: [], completedFileRenameObserved: false, doneSentinelPresentAtStart: false,
    planChecklistFullyCheckedAtStart: false, uncompletedPlanFilesAtStart: ['example_plan.md'],
    manualReviewOnly: false, tokensSinceLastTestImprovement: 0, highestTestPassCount: 0,
    iterationsOnCurrentStage: 0, recentWarnIterationSeqs: [], completionAttempts: 0,
    loopTasksLedgerResolvedAtStart: false,
  };
  const iteration: LoopIteration = {
    id: 'iter', loopRunId: state.id, seq: 0, stage: 'IMPLEMENT', startedAt: 1, endedAt: 2,
    childInstanceId: null, tokens: 0, costCents: 0, filesChanged: [], filesRead: [], toolCalls: [],
    errors: [], testPassCount: null, testFailCount: null, unresolvedToolCalls: false, workHash: 'hash',
    outputSimilarityToPrev: null, outputExcerpt: '', outputFull: '', progressVerdict: 'OK',
    progressSignals: [], completionSignalsFired: [], verifyStatus: 'not-run', verifyOutputExcerpt: '',
  };
  const readOutstanding = vi.fn(async () => ({ raw: '', needsHuman: false }));
  const runRecordedVerify = vi.fn(async (): Promise<VerifyOutcome> => ({ status: 'passed', output: '', durationMs: 1 }));
  const runFreshEyesReviewGate = vi.fn(async () => ({ blocked: false, ran: true, errored: false }));
  return {
    state, iteration, fullOutput: 'There are no outstanding issues',
    stageMachine: { readOutstanding } as unknown as LoopStageMachine,
    seq: 0, stage: 'IMPLEMENT' as const, completionDetector: {} as LoopCompletionDetector,
    runRecordedVerify, runFreshEyesReviewGate,
    classifyCleanReview: async () => ({ clean: true, confidence: 1, reason: 'clean' }),
    emit: vi.fn(), readOutstanding,
  };
}

describe('review-driven plan rename requirement', () => {
  it('ends with review needed when clean reviews converge without the required rename', async () => {
    const args = fixture();
    const result = await evaluateReviewDrivenCompletion(args);
    expect(result?.status).toBe('completed-needs-review');
    expect(result?.reason).toContain('The plan file was not marked complete');
    expect(args.state.lastCompletionOutcome).toBe('rename-gate');
    expect(args.state.pendingInterventions).toEqual([]);
  });

  it('completes cleanly when this run observed the required rename', async () => {
    const args = fixture();
    args.state.completedFileRenameObserved = true;
    expect((await evaluateReviewDrivenCompletion(args))?.status).toBe('completed');
    expect(args.state.lastCompletionOutcome).toBe('accepted');
  });

  it('keeps ordinary loops eligible without a plan rename requirement', async () => {
    const args = fixture();
    args.state.config.planFile = undefined;
    args.state.config.completion.requireCompletedFileRename = false;
    expect((await evaluateReviewDrivenCompletion(args))?.status).toBe('completed');
  });

  it('retains human follow-up details alongside a missing rename', async () => {
    const args = fixture();
    args.readOutstanding.mockResolvedValue({ raw: 'Needs human: check the device', needsHuman: true });
    const result = await evaluateReviewDrivenCompletion(args);
    expect(result?.reason).toContain('The plan file was not marked complete');
    expect(result?.reason).toContain('check the device');
  });

  it('does not finish early before the required clean review streak', async () => {
    const args = fixture();
    args.state.config.completion.requiredCleanReviewPasses = 2;
    expect(await evaluateReviewDrivenCompletion(args)).toBeNull();
    expect(args.state.lastCompletionOutcome).toBeUndefined();
  });

  it('still verifies and runs the independent review before returning a rename note', async () => {
    const args = fixture();
    args.state.config.completion.verifyCommand = 'example-verify';
    args.state.config.completion.crossModelReview!.enabled = true;
    expect((await evaluateReviewDrivenCompletion(args))?.status).toBe('completed-needs-review');
    expect(args.runRecordedVerify.mock.calls).toEqual([['quick-verify'], ['verify']]);
    expect(args.runFreshEyesReviewGate).toHaveBeenCalledOnce();
  });

  it('keeps a failed verification running rather than ending at the rename gate', async () => {
    const args = fixture();
    args.state.config.completion.verifyCommand = 'example-verify';
    args.runRecordedVerify.mockResolvedValue({ status: 'failed', output: 'Tests failed', durationMs: 1,
      exitCode: 1, failureKind: 'command' });
    expect(await evaluateReviewDrivenCompletion(args)).toBeNull();
    expect(args.iteration.verifyStatus).toBe('failed');
    expect(args.state.pendingInterventions).toHaveLength(1);
  });

  it('keeps a blocking independent review running rather than ending at the rename gate', async () => {
    const args = fixture();
    args.state.config.completion.crossModelReview!.enabled = true;
    args.runFreshEyesReviewGate.mockResolvedValue({ blocked: true, ran: true, errored: false });
    expect(await evaluateReviewDrivenCompletion(args)).toBeNull();
    expect(args.state.consecutiveCleanReviewPasses).toBe(0);
    expect(args.state.lastCompletionOutcome).toBeUndefined();
  });

  it('adds the missing-rename note without weakening a needs-sign-off finish outcome', () => {
    const args = fixture();
    args.state.followUps = ['Check the release device'];
    const terminal: ReviewDrivenTerminal = {
      status: 'needs-sign-off',
      reason: 'Finish checks need your sign-off. Accept re-runs the full check.',
      checks: [{ check: 'verify', result: 'skipped', detail: 'No full check was run.' }],
    };
    const result = applyReviewDrivenCompletionNotes(args.state, terminal);
    expect(result.status).toBe('needs-sign-off');
    expect(result.reason).toContain('Finish checks need your sign-off');
    expect(result.reason).toContain('The plan file was not marked complete');
    expect(result.reason).toContain('Check the release device');
    // The sign-off pause keeps its own outcome (the dispatcher records
    // `unverifiable`); the rename gate never rewrites it.
    expect(args.state.lastCompletionOutcome).toBeUndefined();
  });
});
