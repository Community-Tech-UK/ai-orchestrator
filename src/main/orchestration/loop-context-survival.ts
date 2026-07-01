import path from 'path';
import { promises as fsp } from 'fs';
import { BudgetAction } from '../context/token-budget-tracker';
import { getCompactionCoordinator } from '../context/compaction-coordinator';
import { getLogger } from '../logging/logger';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import type { LoopChildResult } from './loop-coordinator.types';
import { createLoopPendingInput, type LoopIteration, type LoopState } from '../../shared/types/loop.types';

const DEFAULT_CONTEXT_BUDGET_TOKENS = 1_000_000;
const logger = getLogger('LoopContextSurvival');

// B5a: post-compaction rehydration. After a context reset (LF-1 full recycle,
// PLAN→IMPLEMENT transition, or degraded-adapter recovery — anything that
// leaves `childResult.contextCompacted` set), the next prompt starts from a
// blank session. Re-inject the plan file, the active LOOP_TASKS.md ledger, and
// this iteration's recently read/edited files so the fresh session doesn't have
// to rediscover them from scratch. Bounded so a noisy run can't dominate the
// next prompt.
const MAX_REHYDRATE_FILES = 5;
const MAX_REHYDRATE_BYTES_PER_FILE = 20_000;
const MAX_REHYDRATE_TOTAL_BYTES = 50_000;

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

/**
 * B5 post-compaction health canary (pure). The turn immediately after a context
 * reset/compaction starts from a fresh session; if the executor did not survive
 * the reset it typically comes back "void" (no output, no tool calls, no file
 * changes). This predicate decides whether such a void post-compaction turn is a
 * genuine executor/workspace outage that warrants a loud BLOCKED pause, or the
 * agent's own (recoverable) choice to do nothing.
 *
 * It fails ONLY when the turn was void AND a cheap workspace liveness probe
 * (exec + fs) came back not-alive — i.e. the environment is genuinely
 * unresponsive. A void turn with a responsive workspace is left to the normal
 * no-progress path, keeping the canary free of false positives (a failed probe
 * always warrants a pause regardless of compaction-timing attribution).
 */
export interface PostCompactionCanaryInput {
  /** The post-compaction turn produced no output, no tool calls, and no files. */
  iterationVoid: boolean;
  /** Result of the workspace liveness probe (exec + fs). */
  workspaceAlive: boolean;
}

export interface PostCompactionCanaryResult {
  failed: boolean;
  reason: string;
}

export function evaluatePostCompactionCanary(input: PostCompactionCanaryInput): PostCompactionCanaryResult {
  if (!input.iterationVoid) {
    return { failed: false, reason: 'post-compaction turn produced a usable turn' };
  }
  if (!input.workspaceAlive) {
    return {
      failed: true,
      reason: 'workspace liveness probe failed after a context reset — the executor is not wired',
    };
  }
  return {
    failed: false,
    reason: 'void post-compaction turn but workspace is responsive — deferring to normal no-progress handling',
  };
}

export interface ApplyLoopContextSurvivalDecisionOptions extends LoopContextSurvivalContext {
  manager: LoopContextSurvivalManager | null;
  pendingContextReset: Set<string>;
  emit: (eventName: string, payload: unknown) => void;
  /**
   * When the operator/reviewer already queued interventions for the next
   * iteration, suppress the automated budget nudge (it would pile automated
   * hints on top of active steering). B5a rehydration is NOT suppressed —
   * surviving a context reset must happen regardless of what else is queued.
   */
  suppressNudge?: boolean;
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

/**
 * Collect the small, fixed set of paths worth rehydrating after a context
 * reset: the plan file, the LOOP_TASKS.md ledger, and this iteration's recently
 * read/edited files. Deduped, capped at `MAX_REHYDRATE_FILES`, resolved to
 * absolute paths.
 */
function buildRehydrationPaths(state: LoopState, childResult: LoopChildResult): string[] {
  const cwd = state.config.workspaceCwd;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined | null) => {
    if (!candidate || out.length >= MAX_REHYDRATE_FILES) return;
    const resolved = path.isAbsolute(candidate) ? candidate : path.join(cwd, candidate);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  };
  add(state.config.planFile);
  add(resolveLoopArtifactPaths(cwd, state.id).tasks);
  for (const readPath of childResult.filesRead ?? []) {
    add(readPath);
  }
  for (const change of childResult.filesChanged) {
    add(change.path);
  }
  return out;
}

/** Load rehydration file contents into one budgeted note, skipping unreadable paths. */
async function loadRehydrationContent(paths: readonly string[]): Promise<string> {
  const sections: string[] = [];
  let remaining = MAX_REHYDRATE_TOTAL_BYTES;
  for (const filePath of paths) {
    if (remaining <= 0) break;
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, 'utf8');
    } catch {
      continue; // Missing/unreadable (e.g. no plan file configured) — skip silently.
    }
    const perFileCap = Math.min(MAX_REHYDRATE_BYTES_PER_FILE, remaining);
    const clipped = raw.length > perFileCap ? `${raw.slice(0, perFileCap)}\n… [truncated]` : raw;
    sections.push(`### ${filePath}\n${clipped}`);
    remaining -= clipped.length;
  }
  return sections.join('\n\n');
}

class DefaultLoopContextSurvivalManager implements LoopContextSurvivalManager {
  async onIterationSealed(
    { state, iteration, childResult }: LoopContextSurvivalContext,
  ): Promise<LoopContextSurvivalDecision> {
    // Independent of the budget/compaction gate below: whenever a context
    // reset just happened (however it was triggered), the next prompt starts
    // from a blank session and benefits from rehydration — including when
    // this loop's own compaction bookkeeping is disabled or self-managed.
    const rehydrate = childResult.contextCompacted
      ? buildRehydrationPaths(state, childResult)
      : undefined;
    const withRehydrate = (decision: LoopContextSurvivalDecision): LoopContextSurvivalDecision =>
      rehydrate && rehydrate.length > 0 ? { ...decision, rehydrate } : decision;

    if (state.config.context?.compaction.enabled === false) {
      return withRehydrate(noDecision('context compaction disabled'));
    }

    const budgetTokens = resolveBudgetTokens(state);
    const tracker = getCompactionCoordinator().getBudgetTracker(state.id, budgetTokens);
    tracker.recordContinuation(iteration.tokens);
    const budget = tracker.checkBudget({
      turnTokens: iteration.tokens,
      totalBudget: budgetTokens,
    });

    if (budget.action === BudgetAction.STOP) {
      return withRehydrate(noDecision(budget.reason ?? 'token budget stop condition reached'));
    }

    if (hasSufficientCompletionSignal(iteration) && budget.nudgeMessage) {
      return withRehydrate({
        action: 'none',
        forceContextReset: false,
        nudge: budget.nudgeMessage,
        reason: 'completion signal fired under token target',
      });
    }

    return withRehydrate(noDecision('token budget remains healthy'));
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
  const nudgeText = decision.nudge?.trim();
  // The budget nudge yields to active steering; rehydration below does not.
  const nudge = nudgeText && !options.suppressNudge ? nudgeText : undefined;
  if (nudge) {
    options.state.pendingInterventions.push(
      createLoopPendingInput(nudge, { kind: 'queue', source: 'context-survival' }),
    );
  }

  // B5: rehydrate plan/ledger/recent files after a context reset. Best-effort
  // — a read failure here must never block the loop from continuing.
  let rehydrated = false;
  if (decision.rehydrate && decision.rehydrate.length > 0) {
    try {
      const content = await loadRehydrationContent(decision.rehydrate);
      if (content.trim()) {
        options.state.pendingInterventions.push(
          createLoopPendingInput(
            `Restored working set (context was just reset to a fresh session):\n\n${content}`,
            { kind: 'queue', source: 'context-survival' },
          ),
        );
        rehydrated = true;
      }
    } catch (err) {
      logger.warn('Loop context survival rehydration failed', {
        loopRunId: options.state.id,
        seq: options.iteration.seq,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!decision.forceContextReset && !nudge && !rehydrated && decision.action === 'none') return;
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
    rehydrated,
  });
}
