import { describe, expect, it, vi } from 'vitest';
import { defaultCrossModelReviewConfig, defaultLoopConfig, type LoopFinalAuditResult, type LoopIteration, type LoopState } from '../../shared/types/loop.types';
import { evaluateReviewDrivenCompletion, type FreshEyesGateResult } from './loop-coordinator-completion-gates';
import type { LoopCompletionDetector, VerifyOutcome } from './loop-completion-detector';
import type { ReviewDrivenTerminal } from './loop-finish-phase';
import { applyReviewDrivenTerminal } from './loop-review-driven-terminal';
import type { LoopStageMachine } from './loop-stage-machine';

function fixture() {
  const config = defaultLoopConfig(process.cwd(), 'Finish the plan');
  config.planFile = 'example_plan.md';
  config.completion.mode = 'review-driven';
  config.completion.requireCompletedFileRename = true;
  config.completion.crossModelReview = { ...defaultCrossModelReviewConfig(), enabled: false };
  config.audit.finalAuditMode = 'off';
  const state = {
    id: 'finish-loop', config, status: 'running', pendingInterventions: [],
    completedFileRenameObserved: true, consecutiveCleanReviewPasses: 0,
    finishPhase: { enteredAtSeq: 0, roundsUsed: 0, maxRounds: 3 },
  } as unknown as LoopState;
  const iteration = {
    id: 'finish-iteration', loopRunId: state.id, seq: 1, stage: 'IMPLEMENT',
    filesChanged: [], completionSignalsFired: [], verifyStatus: 'not-run', verifyOutputExcerpt: '',
  } as unknown as LoopIteration;
  const readOutstanding = vi.fn(async () => ({ raw: '', needsHuman: false }));
  const input = {
    state, iteration, fullOutput: 'There are no outstanding issues',
    stageMachine: { readOutstanding } as unknown as LoopStageMachine,
    seq: 1, stage: 'IMPLEMENT' as const, completionDetector: {} as LoopCompletionDetector,
    classifyCleanReview: async () => ({ clean: true, confidence: 1, reason: 'clean' }),
    runRecordedVerify: vi.fn(async (): Promise<VerifyOutcome> => ({ status: 'passed', output: 'FULL CHECK EVIDENCE', durationMs: 1 })),
    runFreshEyesReviewGate: vi.fn(async (_signal: string, _iteration: LoopIteration, _output: string): Promise<FreshEyesGateResult> => ({ blocked: false, ran: true, errored: false })),
    emit: vi.fn(),
  };
  const audit = vi.fn(async (): Promise<LoopFinalAuditResult> => ({
    status: 'passed', findings: [], ranAt: 1, changedFiles: [],
    coverage: { criteriaTotal: 1, criteriaVerified: 1, criteriaUnverified: 0,
      verifyCommandRan: true, repoComparisonRan: true, cleanlinessScanRan: true },
  }));
  const dispatch = (terminal: ReviewDrivenTerminal | null) => applyReviewDrivenTerminal({
    state, iteration, stageMachine: input.stageMachine, terminal, capWrapUpActive: false, emit: input.emit,
    terminate: (status, reason) => { state.status = status; state.endReason = reason; },
    pause: (reason) => { state.status = 'paused'; state.endReason = reason; },
    handleAuditBlocked: async () => 'continue', audit,
  });
  return { state, iteration, input, readOutstanding, audit, dispatch };
}

describe('review-driven completion through the terminal dispatcher', () => {
  it('pauses a renamed strict plan when the finish round skipped the full check', async () => {
    const { state, input, dispatch } = fixture();
    const terminal = await evaluateReviewDrivenCompletion(input);
    expect(terminal).toMatchObject({ status: 'needs-sign-off', checks: expect.arrayContaining([
      expect.objectContaining({ check: 'verify', result: 'skipped' }),
    ]) });
    expect(await dispatch(terminal)).toBe('continue');
    expect(state.status).toBe('paused');
    expect(state.lastCompletionOutcome).toBe('unverifiable');
    expect(state.endEvidence?.['finishChecks']).toEqual(terminal?.checks);
  });

  it('keeps an unspent finish round running when its independent reviewer errors', async () => {
    const { state, input, dispatch } = fixture();
    state.config.completion.verifyCommand = 'fixture-verify';
    state.config.completion.crossModelReview!.enabled = true;
    input.runFreshEyesReviewGate.mockResolvedValue({ blocked: false, ran: true, errored: true });
    const terminal = await evaluateReviewDrivenCompletion(input);
    expect(terminal).toBeNull();
    expect(await dispatch(terminal)).toBe('none');
    expect(state.status).toBe('running');
    expect(state.consecutiveCleanReviewPasses).toBe(0);
  });

  it.each(['blocked', 'errored'] as const)('pauses on a %s reviewer after spending the finish budget', async failure => {
    const { state, input, dispatch } = fixture();
    state.config.completion.verifyCommand = 'fixture-verify';
    state.config.completion.crossModelReview!.enabled = true;
    state.finishPhase!.roundsUsed = 3;
    input.runFreshEyesReviewGate.mockResolvedValue({ blocked: failure === 'blocked', ran: true, errored: failure === 'errored' });
    const terminal = await evaluateReviewDrivenCompletion(input);
    expect(terminal).toMatchObject({ status: 'needs-sign-off' });
    await dispatch(terminal);
    expect(state.status).toBe('paused');
    expect(state.endEvidence?.['finishChecks']).toContainEqual(expect.objectContaining({ check: 'second-opinion', result: 'failed' }));
  });

  it('preserves verification evidence for the reviewer and completion event', async () => {
    const { state, iteration, input, dispatch } = fixture();
    state.config.completion.verifyCommand = 'fixture-verify';
    state.config.completion.crossModelReview!.enabled = true;
    let reviewedOutput: string | undefined;
    input.runFreshEyesReviewGate.mockImplementation(async (_signal, _iteration, output) => {
      reviewedOutput = output;
      return { blocked: false, ran: true, errored: false };
    });
    await dispatch(await evaluateReviewDrivenCompletion(input));
    expect(reviewedOutput).toBe('FULL CHECK EVIDENCE');
    expect(iteration.verifyOutputExcerpt).toBe('FULL CHECK EVIDENCE');
    expect(state.status).toBe('completed');
    expect(input.emit).toHaveBeenCalledWith('loop:completed', expect.objectContaining({ verifyOutput: 'FULL CHECK EVIDENCE' }));
  });

  it.each([0, 3])('retains final-audit failure authority at finish round %i', async roundsUsed => {
    const { state, input, audit, dispatch } = fixture();
    state.config.completion.verifyCommand = 'fixture-verify';
    state.config.audit.finalAuditMode = 'gate';
    state.finishPhase!.roundsUsed = roundsUsed;
    audit.mockResolvedValue({ ...(await audit()), status: 'failed', findings: [{ code: 'ledger-open', severity: 'blocking', message: 'Acceptance remains open.' }] });
    const action = await dispatch(await evaluateReviewDrivenCompletion(input));
    expect(action).toBe('continue');
    expect(state.status).toBe(roundsUsed === 0 ? 'running' : 'paused');
    expect(state.status).not.toBe('completed');
    if (roundsUsed === 0) expect(state.pendingInterventions.at(-1)?.message).toContain('Acceptance remains open');
    else expect(state.endEvidence?.['finishChecks']).toContainEqual(expect.objectContaining({ check: 'final-audit', result: 'failed' }));
  });

  it('keeps a missing rename as needs-review when the full check passed', async () => {
    const { state, input, readOutstanding, dispatch } = fixture();
    state.completedFileRenameObserved = false;
    state.config.completion.verifyCommand = 'fixture-verify';
    state.followUps = ['Check the release device'];
    readOutstanding.mockResolvedValue({ raw: 'Needs human: choose release timing', needsHuman: true });
    const terminal = await evaluateReviewDrivenCompletion(input);
    expect(terminal).toMatchObject({ status: 'completed-needs-review', checks: expect.any(Array) });
    await dispatch(terminal);
    expect(state.status).toBe('completed-needs-review');
    expect(state.lastCompletionOutcome).toBe('rename-gate');
    expect(state.endReason).toContain('The plan file was not marked complete');
    expect(state.endReason).toContain('choose release timing');
    expect(state.endReason).toContain('Check the release device');
  });

  it('preserves needs-sign-off when the full check was skipped and the rename is missing', async () => {
    const { state, input, readOutstanding, dispatch } = fixture();
    state.completedFileRenameObserved = false;
    state.config.completion.verifyCommand = '';
    state.followUps = ['Check the release device'];
    readOutstanding.mockResolvedValue({ raw: 'Needs human: choose release timing', needsHuman: true });
    const terminal = await evaluateReviewDrivenCompletion(input);
    // The strict-plan skipped check keeps its sign-off authority; the missing
    // rename only adds a note, it never downgrades the pause.
    expect(terminal).toMatchObject({ status: 'needs-sign-off', checks: expect.arrayContaining([
      expect.objectContaining({ check: 'verify', result: 'skipped' }),
    ]) });
    await dispatch(terminal);
    expect(state.status).toBe('paused');
    expect(state.lastCompletionOutcome).toBe('unverifiable');
    expect(state.endReason).toContain('The plan file was not marked complete');
    expect(state.endReason).toContain('Check the release device');
    expect(state.endReason).toContain('Finish checks need your sign-off');
  });

  it('does not let a missing rename hide a failed check at the finish cap', async () => {
    const { state, input, dispatch } = fixture();
    state.completedFileRenameObserved = false;
    state.finishPhase!.roundsUsed = 3;
    state.config.completion.verifyCommand = 'fixture-verify';
    input.runRecordedVerify.mockResolvedValue({ status: 'failed', output: 'Acceptance failed', durationMs: 1, failureKind: 'command', exitCode: 1 });
    await dispatch(await evaluateReviewDrivenCompletion(input));
    expect(state.status).toBe('paused');
    expect(state.lastCompletionOutcome).toBe('unverifiable');
  });

  it('preserves known failures and follow-ups when a finish outcome is recalculated', async () => {
    const { state, input, dispatch } = fixture();
    state.config.completion.requireCompletedFileRename = false;
    state.config.planFile = undefined;
    state.knownFailures = ['Existing baseline failure'];
    state.followUps = ['Device check remains'];
    await dispatch(await evaluateReviewDrivenCompletion(input));
    expect(state.status).toBe('completed-needs-review');
    expect(state.endReason).toContain('Existing baseline failure');
    expect(state.endReason).toContain('Device check remains');
    expect(state.endEvidence?.['finishChecks']).toContainEqual(expect.objectContaining({ check: 'verify', result: 'skipped' }));
  });

  it('keeps ordinary skipped-check finish rounds eligible to end with notes', async () => {
    const { state, input, dispatch } = fixture();
    state.config.completion.requireCompletedFileRename = false;
    state.config.planFile = undefined;
    await dispatch(await evaluateReviewDrivenCompletion(input));
    expect(state.status).toBe('completed-needs-review');
    expect(state.endEvidence?.['mergeHold']).toBe(true);
  });

  it('keeps one copy of human questions when dispatching a non-finish completion', async () => {
    const { state, input, readOutstanding, dispatch } = fixture();
    delete state.finishPhase;
    state.config.completion.requiredCleanReviewPasses = 1;
    readOutstanding.mockResolvedValue({ raw: 'Needs human: choose release timing', needsHuman: true });
    await dispatch(await evaluateReviewDrivenCompletion(input));
    expect(state.status).toBe('completed-needs-review');
    expect(state.endReason?.match(/choose release timing/g)).toHaveLength(1);
  });
});
