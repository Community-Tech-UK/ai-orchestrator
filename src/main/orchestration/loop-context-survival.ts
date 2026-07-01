import { BudgetAction } from '../context/token-budget-tracker';
import { getCompactionCoordinator } from '../context/compaction-coordinator';
import { getLogger } from '../logging/logger';
import type { LoopChildResult } from './loop-coordinator.types';
import { createLoopPendingInput, type LoopIteration, type LoopState } from '../../shared/types/loop.types';

const DEFAULT_CONTEXT_BUDGET_TOKENS = 1_000_000;
const logger = getLogger('LoopContextSurvival');

export interface LoopContextSurvivalContext {
  state: LoopState;
  iteration: LoopIteration;
  childResult: LoopChildResult;
}

export interface LoopContextSurvivalDecision {
  action: 'none' | 'micro' | 'summarize' | 'fresh-window';
  forceContextReset: boolean;
  rehydrate?: string[];
  nudge?: string;
  reason: string;
}

export interface LoopContextSurvivalManager {
  onIterationSealed(ctx: LoopContextSurvivalContext): Promise<LoopContextSurvivalDecision>;
}

export interface ApplyLoopContextSurvivalDecisionOptions extends LoopContextSurvivalContext {
  manager: LoopContextSurvivalManager | null;
  pendingContextReset: Set<string>;
  emit: (eventName: string, payload: unknown) => void;
}

function noDecision(reason: string): LoopContextSurvivalDecision {
  return { action: 'none', forceContextReset: false, reason };
}

function hasSufficientCompletionSignal(iteration: LoopIteration): boolean {
  return iteration.completionSignalsFired.some((signal) => signal.sufficient);
}

function resolveBudgetTokens(state: LoopState): number {
  return state.config.caps.maxTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
}

class DefaultLoopContextSurvivalManager implements LoopContextSurvivalManager {
  async onIterationSealed({ state, iteration }: LoopContextSurvivalContext): Promise<LoopContextSurvivalDecision> {
    if (state.config.context?.compaction.enabled === false) {
      return noDecision('context compaction disabled');
    }

    const budgetTokens = resolveBudgetTokens(state);
    const tracker = getCompactionCoordinator().getBudgetTracker(state.id, budgetTokens);
    tracker.recordContinuation(iteration.tokens);
    const budget = tracker.checkBudget({
      turnTokens: iteration.tokens,
      totalBudget: budgetTokens,
    });

    if (budget.action === BudgetAction.STOP) {
      return noDecision(budget.reason ?? 'token budget stop condition reached');
    }

    if (hasSufficientCompletionSignal(iteration) && budget.nudgeMessage) {
      return {
        action: 'none',
        forceContextReset: false,
        nudge: budget.nudgeMessage,
        reason: 'completion signal fired under token target',
      };
    }

    return noDecision('token budget remains healthy');
  }
}

export const defaultLoopContextSurvivalManager: LoopContextSurvivalManager =
  new DefaultLoopContextSurvivalManager();

export async function applyLoopContextSurvivalDecision(
  options: ApplyLoopContextSurvivalDecisionOptions,
): Promise<void> {
  if (!options.manager) return;
  let decision: LoopContextSurvivalDecision;
  try {
    decision = await options.manager.onIterationSealed(options);
  } catch (err) {
    logger.warn('Loop context survival manager threw', {
      loopRunId: options.state.id,
      seq: options.iteration.seq,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (decision.forceContextReset) options.pendingContextReset.add(options.state.id);
  const nudge = decision.nudge?.trim();
  if (nudge) {
    options.state.pendingInterventions.push(
      createLoopPendingInput(nudge, { kind: 'queue', source: 'context-survival' }),
    );
  }
  if (!decision.forceContextReset && !nudge && decision.action === 'none') return;
  const eventPayload = {
    loopRunId: options.state.id,
    seq: options.iteration.seq,
    action: decision.action,
    forceContextReset: decision.forceContextReset,
    reason: decision.reason,
  };
  options.emit('loop:context-survival-decision', eventPayload);
  logger.info('Loop context survival decision applied', {
    ...eventPayload,
    nudge: Boolean(nudge),
  });
}
