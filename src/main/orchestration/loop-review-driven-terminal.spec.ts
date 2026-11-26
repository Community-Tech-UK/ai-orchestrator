import { expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import type { LoopStageMachine } from './loop-stage-machine';
import { applyReviewDrivenTerminal } from './loop-review-driven-terminal';

it.each(['cancelled', 'paused'] as const)('does not overwrite %s during the final question read', async status => {
  let finishRead: (value: { raw: string; needsHuman: boolean }) => void = () => undefined;
  const readOutstanding = vi.fn(() => new Promise<{ raw: string; needsHuman: boolean }>(resolve => { finishRead = resolve; }));
  const state = { id: 'run', status: 'running', config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  const terminate = vi.fn(); const emit = vi.fn();
  const action = applyReviewDrivenTerminal({ state, iteration: { verifyStatus: 'passed' } as NonNullable<LoopState['lastIteration']>, stageMachine: { readOutstanding } as unknown as LoopStageMachine,
    terminal: { status: 'completed', reason: 'Checks passed.' }, capWrapUpActive: false, emit, terminate, pause: vi.fn(),
    handleAuditBlocked: async () => 'continue', audit: async () => ({ status: 'passed', findings: [], ranAt: Date.now(), changedFiles: [], coverage: { criteriaTotal: 0, criteriaVerified: 0, criteriaUnverified: 0, verifyCommandRan: true, repoComparisonRan: true, cleanlinessScanRan: true } }) });
  await vi.waitFor(() => expect(readOutstanding).toHaveBeenCalledOnce());
  state.status = status; finishRead({ raw: '', needsHuman: false });
  await action;
  expect(terminate).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
  expect(state.status).toBe(status);
});

// A failed audit must not begin recovery after the operator parks the run.
it.each(['paused', 'cancelled'] as const)('preserves %s while a failed final audit finishes', async status => {
  const state = { id: 'run', status: 'running', config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  state.config.audit.finalAuditMode = 'gate';
  const handleAuditBlocked = vi.fn(async () => 'terminal' as const);
  const action = await applyReviewDrivenTerminal({ state, iteration: { verifyStatus: 'passed' } as NonNullable<LoopState['lastIteration']>,
    stageMachine: {} as LoopStageMachine, terminal: { status: 'completed', reason: 'Checks passed.' }, capWrapUpActive: false,
    emit: vi.fn(), terminate: vi.fn(), pause: vi.fn(), handleAuditBlocked,
    audit: async () => { state.status = status; return { status: 'failed', findings: [], ranAt: Date.now(), changedFiles: [],
      coverage: { criteriaTotal: 0, criteriaVerified: 0, criteriaUnverified: 0, verifyCommandRan: true, repoComparisonRan: true, cleanlinessScanRan: true } }; } });
  expect(handleAuditBlocked).not.toHaveBeenCalled();
  expect(action).toBe(status === 'paused' ? 'continue' : 'terminal');
  expect(state.status).toBe(status);
});

it('stages a final-audit merge hold when the final audit needs operator review', async () => {
  const state = { id: 'run', status: 'running', config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  state.config.audit.finalAuditMode = 'gate';
  const readOutstanding = vi.fn(async () => ({ raw: '', needsHuman: false }));
  const terminate = vi.fn(); const emit = vi.fn();
  const action = await applyReviewDrivenTerminal({ state, iteration: { verifyStatus: 'passed' } as NonNullable<LoopState['lastIteration']>,
    stageMachine: { readOutstanding } as unknown as LoopStageMachine, terminal: { status: 'completed', reason: 'Checks passed.' },
    capWrapUpActive: false, emit, terminate, pause: vi.fn(), handleAuditBlocked: async () => 'continue',
    audit: async () => ({ status: 'needs-review', findings: [], ranAt: Date.now(), changedFiles: [],
      coverage: { criteriaTotal: 0, criteriaVerified: 0, criteriaUnverified: 0, verifyCommandRan: true, repoComparisonRan: true, cleanlinessScanRan: true } }) });
  expect(action).toBe('terminal');
  expect(state.endEvidence).toMatchObject({ mergeHold: true, mergeHoldKind: 'final-audit-blocked' });
  expect(terminate).toHaveBeenCalledWith('completed-needs-review', expect.stringContaining('Final audit requires operator review'));
});

it('stages a final-audit merge hold when the incoming terminal is already completed-needs-review', async () => {
  const state = { id: 'run', status: 'running', config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  state.config.audit.finalAuditMode = 'gate';
  const readOutstanding = vi.fn(async () => ({ raw: '', needsHuman: false }));
  const terminate = vi.fn(); const emit = vi.fn();
  const action = await applyReviewDrivenTerminal({ state, iteration: { verifyStatus: 'passed' } as NonNullable<LoopState['lastIteration']>,
    stageMachine: { readOutstanding } as unknown as LoopStageMachine,
    terminal: { status: 'completed-needs-review', reason: 'A check was skipped.' },
    capWrapUpActive: false, emit, terminate, pause: vi.fn(), handleAuditBlocked: async () => 'continue',
    audit: async () => ({ status: 'needs-review', findings: [], ranAt: Date.now(), changedFiles: [],
      coverage: { criteriaTotal: 0, criteriaVerified: 0, criteriaUnverified: 0, verifyCommandRan: true, repoComparisonRan: true, cleanlinessScanRan: true } }) });
  expect(action).toBe('terminal');
  expect(state.endEvidence).toMatchObject({ mergeHold: true, mergeHoldKind: 'final-audit-blocked' });
  expect(terminate).toHaveBeenCalledWith('completed-needs-review', expect.any(String));
});
