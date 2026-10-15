import { beforeEach, expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopFinalAuditResult, type LoopState } from '../../shared/types/loop.types';
import type { LoopStageMachine } from './loop-stage-machine';
import { handleLoopFinalAuditBlockedCompletion, handleVerifiedNoChangeReviewDrivenCompletion } from './loop-final-audit-blocked-completion';
import { applyLoopPhaseRecovery } from './loop-phase-recovery';

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
