import { createLoopPendingInput, type LoopFinalAuditResult, type LoopIteration, type LoopState } from '../../shared/types/loop.types';
import type { LoopStageMachine } from './loop-stage-machine';
import { buildFinalAuditIntervention, runLoopFinalAudit } from './loop-audit-runtime';
import { decideFinishOutcome, stageFinishEvidence, type ReviewDrivenTerminal, type FinishCheck } from './loop-finish-phase';
import { isParkedLoopRuntimeState, isTerminalLoopRuntimeState } from './loop-runtime-status';
import { applyOutstandingCompletionGate } from './loop-outstanding-completion';

export async function applyReviewDrivenTerminal(ctx: {
  state: LoopState; iteration: LoopIteration; stageMachine: LoopStageMachine;
  terminal: ReviewDrivenTerminal | null; capWrapUpActive: boolean;
  emit: (event: string, payload: unknown) => void;
  terminate: (status: LoopState['status'], reason: string) => void;
  pause: (reason: string) => void;
  handleAuditBlocked: (audit: LoopFinalAuditResult) => Promise<'continue' | 'terminal'>;
  audit?: typeof runLoopFinalAudit;
}): Promise<'terminal' | 'continue' | 'none'> {
  let terminal = ctx.terminal;
  if (!terminal || (ctx.capWrapUpActive && terminal.status !== 'completed')) return 'none';
  const { state, iteration } = ctx;
  const inheritedOnly = terminal.checks?.some((check) => check.check === 'verify' && check.result === 'already-failing');
  const audit = await (ctx.audit ?? runLoopFinalAudit)(state, iteration,
    iteration.verifyStatus === 'passed' || inheritedOnly ? 'passed' : iteration.verifyStatus === 'failed' ? 'failed' : 'skipped', ctx.stageMachine);
  if (isTerminalLoopRuntimeState(state)) return 'terminal';
  if (isParkedLoopRuntimeState(state)) return 'continue';
  if (state.finishPhase && terminal.checks) {
    const checks: FinishCheck[] = [...terminal.checks];
    if (state.config.audit.finalAuditMode !== 'off') {
      checks.push({ check: 'final-audit', result: audit.status === 'passed' ? 'passed'
        : audit.status === 'failed' ? 'failed' : 'skipped', detail: audit.status === 'passed'
          ? 'Passed.' : audit.findings.map((finding) => finding.message).join('; ') || 'Not verified.' });
    }
    const outcome = decideFinishOutcome({ state, clean: checks.some((check) => check.check === 'self-review' && check.result === 'passed'), checks });
    if (!outcome) {
      state.consecutiveCleanReviewPasses = 0;
      if (audit.status === 'failed') state.pendingInterventions.push(createLoopPendingInput(buildFinalAuditIntervention(audit)));
      return 'continue';
    }
    terminal = { status: outcome.kind === 'completed-with-notes' ? 'completed-needs-review' : outcome.kind, reason: outcome.reason, checks };
  } else {
    if (state.config.audit.finalAuditMode === 'gate' && audit.status === 'failed') return ctx.handleAuditBlocked(audit);
    if (terminal.status === 'completed' && state.config.audit.finalAuditMode === 'gate' && audit.status === 'needs-review') {
      terminal = { status: 'completed-needs-review', reason: 'Final audit requires operator review before this loop can be considered cleanly complete.' };
    }
  }
  terminal = await applyOutstandingCompletionGate(terminal, ctx.stageMachine);
  if (isTerminalLoopRuntimeState(state)) return 'terminal';
  if (isParkedLoopRuntimeState(state)) return 'continue';
  if (terminal.status === 'needs-sign-off') {
    state.lastCompletionOutcome = 'unverifiable';
    state.endEvidence = { ...state.endEvidence, finishChecks: terminal.checks, mergeHold: false };
    ctx.pause(terminal.reason);
    return 'continue';
  }
  let reason = terminal.reason;
  if (terminal.checks) {
    stageFinishEvidence(state, terminal.checks);
    if (state.endEvidence?.['mergeHold'] && state.config.isolateLoopWorkspaces) {
      reason += `\nNothing was merged because a check was skipped. Merge it when you have looked (branch ${state.worktreeLifecycle?.sessionBranch ?? state.config.worktreeBranch ?? 'kept by Harness'}).`;
    }
  }
  if (state.followUps?.length) reason += `\nFollow-ups:\n${state.followUps.join('\n')}`;
  ctx.emit(terminal.status === 'completed' ? 'loop:completed' : 'loop:completed-needs-review', {
    loopRunId: state.id, signal: 'self-declared', verifyOutput: '', reason, acceptedByOperator: false,
  });
  ctx.terminate(terminal.status, reason);
  return 'terminal';
}
