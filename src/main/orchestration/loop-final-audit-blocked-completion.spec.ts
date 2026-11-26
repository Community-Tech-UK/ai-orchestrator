import { beforeEach, expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopFinalAuditResult, type LoopState } from '../../shared/types/loop.types';
import type { LoopStageMachine } from './loop-stage-machine';
import { handleLoopFinalAuditBlockedCompletion, handleVerifiedNoChangeReviewDrivenCompletion } from './loop-final-audit-blocked-completion';
import { runLoopFinalAudit } from './loop-audit-runtime';
import { applyLoopPhaseRecovery } from './loop-phase-recovery';
import { holdsMergeForReview } from './loop-worktree-lifecycle';
import { describeLoopEnd } from '../../shared/loop/loop-end-wording';

beforeEach(() => vi.clearAllMocks());

vi.mock('./loop-audit-runtime', () => ({
  buildFinalAuditIntervention: () => 'Fix the audit.',
  runLoopFinalAudit: vi.fn(async (state: LoopState) => {
    state.status = 'paused';
    return { status: 'failed', findings: [] };
  }),
}));
vi.mock('./loop-phase-recovery', () => ({
  applyLoopPhaseRecovery: vi.fn(async ({ state }: { state: LoopState }) => {
    state.status = 'paused';
    return { status: 'handoff', terminalStatus: 'no-progress', reason: 'Repeated findings.' };
  }),
}));

it('does not terminate or emit handoff after recovery parks the run', async () => {
  const state = { id: 'run', status: 'running', config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  const terminate = vi.fn(); const emitClaimedDoneButFailed = vi.fn(); const emitCompletedNeedsReview = vi.fn();
  const rejectPendingCompleteIntent = vi.fn(); const rejectCompletionAttempt = vi.fn(); const setConvergenceNote = vi.fn();
  const action = await handleLoopFinalAuditBlockedCompletion({ state, iteration: undefined,
    finalAudit: { status: 'failed', findings: [] } as unknown as LoopFinalAuditResult, stageMachine: {} as LoopStageMachine,
    signal: 'self-declared', terminate, emitClaimedDoneButFailed, emitCompletedNeedsReview,
    rejectPendingCompleteIntent, rejectCompletionAttempt, setConvergenceNote });
  expect(action).toBe('continue'); expect(state.status).toBe('paused');
  for (const sink of [terminate, emitClaimedDoneButFailed, emitCompletedNeedsReview, rejectPendingCompleteIntent, rejectCompletionAttempt, setConvergenceNote]) {
    expect(sink).not.toHaveBeenCalled();
  }
});

it('does not start blocked recovery after a verified no-change audit parks the run', async () => {
  const state = { id: 'run', status: 'running', config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  state.config.audit.finalAuditMode = 'gate';
  const handleBlockedCompletion = vi.fn(async () => 'terminal' as const); const terminate = vi.fn(); const emitCompletedNeedsReview = vi.fn();
  const action = await handleVerifiedNoChangeReviewDrivenCompletion({ state, iteration: { verifyStatus: 'passed' } as NonNullable<LoopState['lastIteration']>,
    stageMachine: {} as LoopStageMachine, handleBlockedCompletion, terminate, emitCompletedNeedsReview });
  expect(action).toBe('continue'); expect(state.status).toBe('paused');
  expect(handleBlockedCompletion).not.toHaveBeenCalled(); expect(terminate).not.toHaveBeenCalled(); expect(emitCompletedNeedsReview).not.toHaveBeenCalled();
});

it.each([false, true])('handles an already-paused audit only for operator Accept (%s)', async (operatorAccept) => {
  const state = { id: 'run', status: 'paused', lastCompletionOutcome: 'unverifiable',
    config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  const rejectCompletionAttempt = vi.fn(); const emitClaimedDoneButFailed = vi.fn();
  const terminate = vi.fn(); const emitCompletedNeedsReview = vi.fn();
  const result = await handleLoopFinalAuditBlockedCompletion({
    state, iteration: undefined, finalAudit: { status: 'failed', findings: [] } as unknown as LoopFinalAuditResult,
    stageMachine: {} as LoopStageMachine, signal: 'declared-complete', operatorAccept,
    rejectCompletionAttempt, emitClaimedDoneButFailed, terminate, emitCompletedNeedsReview,
    rejectPendingCompleteIntent: vi.fn(), setConvergenceNote: vi.fn(),
  });
  expect(result).toBe('continue'); expect(state.status).toBe('paused');
  expect(applyLoopPhaseRecovery).not.toHaveBeenCalled();
  expect(terminate).not.toHaveBeenCalled(); expect(emitCompletedNeedsReview).not.toHaveBeenCalled();
  if (operatorAccept) {
    expect(state.lastCompletionOutcome).toBe('review-blocked');
    expect(rejectCompletionAttempt).toHaveBeenCalledWith(state, 'final audit blocked completion', 'Fix the audit.');
    expect(emitClaimedDoneButFailed).toHaveBeenCalledWith({ loopRunId: 'run', signal: 'declared-complete', failure: 'Fix the audit.' });
  } else {
    expect(state.lastCompletionOutcome).toBe('unverifiable');
    expect(rejectCompletionAttempt).not.toHaveBeenCalled(); expect(emitClaimedDoneButFailed).not.toHaveBeenCalled();
  }
});

it('stages a final-audit merge hold on the recovery handoff ending', async () => {
  const state = { id: 'run', status: 'running', config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  vi.mocked(applyLoopPhaseRecovery).mockResolvedValueOnce({ status: 'handoff', terminalStatus: 'completed-needs-review', reason: 'Needs you.' } as never);
  const terminate = vi.fn(); const emitCompletedNeedsReview = vi.fn();
  const action = await handleLoopFinalAuditBlockedCompletion({ state, iteration: undefined,
    finalAudit: { status: 'failed', findings: [] } as unknown as LoopFinalAuditResult, stageMachine: {} as LoopStageMachine,
    signal: 'self-declared', terminate, emitClaimedDoneButFailed: vi.fn(), emitCompletedNeedsReview,
    rejectPendingCompleteIntent: vi.fn(), rejectCompletionAttempt: vi.fn(), setConvergenceNote: vi.fn() });
  expect(action).toBe('terminal');
  expect(state.endEvidence).toMatchObject({ mergeHold: true, mergeHoldKind: 'final-audit-blocked' });
  expect(emitCompletedNeedsReview).toHaveBeenCalledWith(expect.objectContaining({ acceptedByOperator: false }));
  expect(terminate).toHaveBeenCalledWith(state, 'completed-needs-review', 'Needs you.');
});

it('stages a no-change review hold on the verified-no-change ending', async () => {
  const state = { id: 'run', status: 'running', config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  vi.mocked(runLoopFinalAudit).mockResolvedValueOnce({ status: 'passed', findings: [] } as never);
  const handleBlockedCompletion = vi.fn(async () => 'terminal' as const);
  const terminate = vi.fn(); const emitCompletedNeedsReview = vi.fn();
  const action = await handleVerifiedNoChangeReviewDrivenCompletion({ state,
    iteration: { verifyStatus: 'passed' } as NonNullable<LoopState['lastIteration']>,
    stageMachine: {} as LoopStageMachine, handleBlockedCompletion, terminate, emitCompletedNeedsReview });
  expect(action).toBe('terminal');
  expect(handleBlockedCompletion).not.toHaveBeenCalled();
  expect(state.endEvidence).toMatchObject({ mergeHold: true, mergeHoldKind: 'verified-no-change' });
  expect(emitCompletedNeedsReview).toHaveBeenCalledWith(expect.objectContaining({ acceptedByOperator: false }));
  expect(terminate).toHaveBeenCalledWith(state, 'completed-needs-review', expect.any(String));
});

it('explains the passed-audit no-change hold without saying its final check is blocked', async () => {
  const state = { id: 'run', status: 'running', config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  state.config.audit.finalAuditMode = 'gate';
  vi.mocked(runLoopFinalAudit).mockResolvedValueOnce({ status: 'passed', findings: [] } as never);
  await handleVerifiedNoChangeReviewDrivenCompletion({ state,
    iteration: { verifyStatus: 'passed' } as NonNullable<LoopState['lastIteration']>,
    stageMachine: {} as LoopStageMachine, handleBlockedCompletion: vi.fn(async () => 'terminal' as const),
    terminate: vi.fn(), emitCompletedNeedsReview: vi.fn() });
  const end = describeLoopEnd({ status: 'completed-needs-review', roundsFinished: 3, endedAt: 1,
    mergeHeld: state.endEvidence?.['mergeHold'] === true,
    mergeHoldKind: String(state.endEvidence?.['mergeHoldKind']), branch: 'loop/kept' });
  expect(end.sentence).not.toContain('final check needs your sign-off');
  expect(end.sentence).toContain('no production changes');
});

it.each(['passed', 'needs-review', 'failed'] as const)('preserves review-only landing after a no-change %s gate audit', async status => {
  const state = { id: 'run', status: 'running', config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  state.config.audit.finalAuditMode = 'gate';
  vi.mocked(runLoopFinalAudit).mockResolvedValueOnce({ status, findings: [] } as never);
  vi.mocked(applyLoopPhaseRecovery).mockResolvedValueOnce({ status: 'handoff', terminalStatus: 'completed-needs-review', reason: 'Needs you.' } as never);
  const terminate = vi.fn(); const emitCompletedNeedsReview = vi.fn();
  const action = await handleVerifiedNoChangeReviewDrivenCompletion({ state,
    iteration: { verifyStatus: 'passed' } as NonNullable<LoopState['lastIteration']>, stageMachine: {} as LoopStageMachine,
    handleBlockedCompletion: args => handleLoopFinalAuditBlockedCompletion({ ...args, terminate,
      emitCompletedNeedsReview, emitClaimedDoneButFailed: vi.fn(), rejectPendingCompleteIntent: vi.fn(),
      rejectCompletionAttempt: vi.fn(), setConvergenceNote: vi.fn() }), terminate, emitCompletedNeedsReview });
  expect(action).toBe('terminal');
  expect(state.endEvidence).toMatchObject({ mergeHold: true,
    mergeHoldKind: status === 'passed' ? 'verified-no-change' : 'final-audit-blocked' });
  expect(holdsMergeForReview('completed-needs-review', state.endEvidence)).toBe(true);
  expect(emitCompletedNeedsReview).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ acceptedByOperator: false }));
  expect(terminate).toHaveBeenCalledWith(state, 'completed-needs-review', expect.any(String));
});
