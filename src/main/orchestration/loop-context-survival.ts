import path from 'path';
import { BudgetAction } from '../context/token-budget-tracker';
import { getCompactionCoordinator } from '../context/compaction-coordinator';
import { getLogger } from '../logging/logger';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import { loopExecutionCwd, loopStateCwd } from './loop-cwd';
import { loopContextUtilization } from './loop-context-discipline';
import type { LoopChildResult } from './loop-coordinator.types';
import {
  createLoopPendingInput,
  defaultLoopContextConfig,
  type LoopIteration,
  type LoopState,
} from '../../shared/types/loop.types';
import {
  clipHandoffInjectNote,
  loadRehydrationNote,
  MAX_REHYDRATE_FILES,
  writeLoopHandoff,
} from './loop-recycle-handoff';

const DEFAULT_CONTEXT_BUDGET_TOKENS = 1_000_000;
const logger = getLogger('LoopContextSurvival');

// B4 (#14): claude-code's cache-TTL time trigger. Anthropic's prompt cache
// (and equivalents on other providers) expires after ~1h idle; once it does,
// the NEXT call re-pays the full prefix cost regardless of token count, so a
// cheap context action is worth recommending even when utilization alone
// wouldn't trigger one yet. Named constant so the threshold is one edit, not
// a buried magic number.
export const CONTEXT_CACHE_TTL_MS = 60 * 60 * 1000;

// B5a / T39: post-compaction rehydration. Caps and pointer+hash loading live
// in loop-recycle-handoff.ts (OpenClaw 1200 / 2800). T6 writes HANDOFF.json.

/** Gated-mode forensic signals that do not mean review-driven/ping-pong is finishing. */
const GATED_ONLY_SURVIVAL_SIGNAL_IDS = new Set([
  'ledger-complete',
  'done-sentinel',
  'completed-rename',
]);

export interface LoopContextSurvivalContext {
  state: LoopState;
  iteration: LoopIteration;
  childResult: LoopChildResult;
  /**
   * Coordinator already decided this iteration will stop or pause. Survival
   * must not inject a keep-working nudge on top of a real finish.
   */
  aboutToComplete?: boolean;
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

function isReviewDrivenOrPingPong(state: LoopState): boolean {
  return state.config.completion.mode === 'review-driven'
    || state.config.completion.crossModelReview?.pingPong?.enabled === true;
}

/**
 * Keep-working is only for a user-set loop token cap when a real completion
 * attempt is still being rejected. A null cap is not a 1M target (T24).
 * Review-driven / ping-pong must ignore gated forensic signals (T24/T28).
 */
function shouldQueueKeepWorkingNudge(
  state: LoopState,
  iteration: LoopIteration,
  aboutToComplete: boolean,
): boolean {
  if (aboutToComplete) return false;
  if (state.config.caps.maxTokens == null) return false;
  if (!hasSufficientCompletionSignal(iteration)) return false;
  if (isReviewDrivenOrPingPong(state)) {
    const remaining = iteration.completionSignalsFired
      .filter((signal) => signal.sufficient)
      .filter((signal) => !GATED_ONLY_SURVIVAL_SIGNAL_IDS.has(signal.id));
    if (remaining.length === 0) return false;
  }
  return true;
}

function loopTokenCapNudge(iterationTokens: number, maxTokens: number): string {
  const fillPercentage = Math.round((iterationTokens / maxTokens) * 100);
  return `Stopped at ${fillPercentage}% of the loop token cap (${iterationTokens} / ${maxTokens}). Keep working — do not summarize.`;
}

function resolveBudgetTokens(state: LoopState): number {
  // Tracker STOP is mapped to noDecision (T27) — this fallback is bookkeeping
  // only and must never appear in a user-facing nudge.
  return state.config.caps.maxTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
}

// B4 idle-gap tracking. `LoopState`/`LoopIteration` carry no "previous
// iteration's end time" — `state.lastIteration` is already reassigned to the
// iteration being sealed by the time this hook runs (loop-coordinator.ts,
// `state.lastIteration = iteration` precedes the survival-decision call), and
// the coordinator's iteration history is a private local, not exposed on
// state. So — same idiom as `TokenBudgetTracker` above, keyed by `state.id`
// (the loopRunId; `childInstanceId` is `null` in production, see B1) — track
// the last-sealed iteration's `endedAt` here. Module-local, not part of
// `LoopState`, so restored/resumed loops just start a fresh idle clock
// (conservative: never fires a stale-cache micro tier spuriously on resume).
const lastIterationEndByLoopId = new Map<string, number>();

/** Test-only: clear idle-gap bookkeeping between spec runs. */
export function _resetContextSurvivalIdleTrackingForTesting(): void {
  lastIterationEndByLoopId.clear();
}

/**
 * Gap since the previous sealed iteration for this loop, or `null` when there
 * is no prior iteration to compare against (first iteration this process has
 * seen — conservatively never treated as a cache-stale gap).
 */
function idleGapMs(state: LoopState, iteration: LoopIteration): number | null {
  const previousEnd = lastIterationEndByLoopId.get(state.id);
  const now = iteration.startedAt;
  return typeof previousEnd === 'number' && Number.isFinite(previousEnd) && Number.isFinite(now)
    ? Math.max(0, now - previousEnd)
    : null;
}

function recordIterationEnd(state: LoopState, iteration: LoopIteration): void {
  const end = iteration.endedAt ?? iteration.startedAt;
  if (Number.isFinite(end)) lastIterationEndByLoopId.set(state.id, end);
}

/**
 * §9 `selfManagesAutoCompaction` guard. Only meaningful when this iteration
 * ran on a *borrowed* live chat instance (`childResult.transcriptBound` —
 * set from `borrowedFromInstance` in `default-invokers.ts`): that is the one
 * case where `state.chatId` names a real, queryable adapter instance. A
 * loop's own persistent same-session adapter (not borrowed) is keyed by
 * `loopRunId`, not an instance id `CompactionCoordinator` knows about, and
 * `fresh-child` iterations have no persistent adapter at all — so for those
 * this predicate is vacuously false (nothing to defer to) and the manager
 * stays free to recommend its own actions.
 */
function isBorrowedAdapterSelfManaged(state: LoopState, childResult: LoopChildResult): boolean {
  if (!childResult.transcriptBound) return false;
  return getCompactionCoordinator().isSelfManagedAutoCompaction(state.chatId);
}

/**
 * Collect the small, fixed set of paths worth rehydrating after a context
 * reset: the plan file, the LOOP_TASKS.md ledger, and this iteration's recently
 * read/edited files. Deduped, capped at `MAX_REHYDRATE_FILES`, resolved to
 * absolute paths.
 */
function buildRehydrationPaths(state: LoopState, childResult: LoopChildResult): string[] {
  // This function genuinely needs BOTH cwds, which is why it is spelled out:
  // the plan file and the agent's read/changed paths are work product (they
  // live in the worktree under isolation), while LOOP_TASKS.md is durable loop
  // state that must stay at the repo root. Resolving the former against the
  // repo root silently dropped the plan pointer from every post-reset
  // rehydration note — or, worse, picked up an unrelated same-named file left
  // there by another loop. See `loop-cwd.ts`.
  const executionCwd = loopExecutionCwd(state.config);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined | null) => {
    if (!candidate || out.length >= MAX_REHYDRATE_FILES) return;
    const resolved = path.isAbsolute(candidate) ? candidate : path.join(executionCwd, candidate);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  };
  add(state.config.planFile);
  add(resolveLoopArtifactPaths(loopStateCwd(state.config), state.id).tasks);
  for (const readPath of childResult.filesRead ?? []) {
    add(readPath);
  }
  for (const change of childResult.filesChanged) {
    add(change.path);
  }
  return out;
}


class DefaultLoopContextSurvivalManager implements LoopContextSurvivalManager {
  async onIterationSealed(
    { state, iteration, childResult, aboutToComplete }: LoopContextSurvivalContext,
  ): Promise<LoopContextSurvivalDecision> {
    // B4 idle-gap measurement happens before any early return so the next
    // iteration always has a fresh baseline, and is recorded unconditionally
    // below (`recordIterationEnd`) regardless of which branch decides the
    // outcome. `gap === null` on the loop's first sealed iteration this
    // process has seen — never treated as stale (conservative default).
    const gap = idleGapMs(state, iteration);
    const cacheStale = gap !== null && gap > CONTEXT_CACHE_TTL_MS;
    recordIterationEnd(state, iteration);

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
      // T27: TokenBudgetTracker.STOP is not a loop governor. Map it to noDecision
      // so diminishing-returns / fill-percentage never halt a cheap finish.
      return withRehydrate(noDecision(budget.reason ?? 'token budget stop condition reached'));
    }

    // B4 (#14): free deterministic pre-compaction pass.
    //
    // What "micro" actually drives here — read this before changing it. The
    // loop delegates whole turns to CLI subprocesses; there is no
    // coordinator-owned message/turn list for ANY `contextStrategy` to run
    // `Microcompact.compact()` against (`same-session` = one persistent
    // adapter process owning its own transcript; `fresh-child` = a new
    // one-shot process per iteration with nothing to compact; `hybrid` is
    // treated as fresh-child by the invoker). `Microcompact`
    // IS wired today, but only inside `ContextCompactor.compactLayered()`
    // (`context-compactor.ts`), which operates on a *different*, singleton,
    // instance-scoped turn buffer used by the borrowed-chat-instance compaction
    // path — not something this per-loop manager can safely drive for an
    // arbitrary loop's persistent session. So `action:'micro'` is a logged
    // no-op (T4), not a compact: bookkeeping + a reason on the emitted
    // event/log, plus `forceContextReset` composed in ONLY when LF-1's own
    // recycle threshold is independently already met (never an extra reset
    // LF-1 wouldn't already be about to trigger on its next occupancy check
    // in `default-invokers.ts`) — i.e. "prefer the cheap tier, escalate only
    // when it's insufficient" without duplicating or racing LF-1.
    //
    // Two triggers land here, both gated by the §9 `selfManagesAutoCompaction`
    // opt-out (Claude CLI self-compacts on a borrowed instance): a stale
    // prompt cache (idle > `CONTEXT_CACHE_TTL_MS`, claude-code's TTL rule —
    // recommended even when utilization wouldn't trigger one) and micro-tier
    // utilization pressure below LF-1's own reset threshold.
    if (cacheStale && !isBorrowedAdapterSelfManaged(state, childResult)) {
      const resetAtUtilization = state.config.context?.compaction.resetAtUtilization
        ?? defaultLoopContextConfig().compaction.resetAtUtilization;
      const utilization = loopContextUtilization(state.totalTokens);
      const alsoOverThreshold = utilization >= resetAtUtilization;
      const gapMinutes = Math.round((gap ?? 0) / 60_000);
      return withRehydrate({
        action: 'micro',
        forceContextReset: alsoOverThreshold,
        reason: alsoOverThreshold
          ? `idle ${gapMinutes}m exceeds cache TTL and utilization ${Math.round(utilization * 100)}% ` +
            `already meets the reset threshold — composing with a full recycle rather than a second reset`
          : `idle ${gapMinutes}m exceeds cache TTL (~60min) — cache prefix will be rewritten on the next ` +
            'call regardless; recording a cheap context note (no coordinator-owned turn list to prune)',
      });
    }

    const maxTokens = state.config.caps.maxTokens;
    if (shouldQueueKeepWorkingNudge(state, iteration, aboutToComplete === true) && maxTokens != null) {
      return withRehydrate({
        action: 'none',
        forceContextReset: false,
        nudge: loopTokenCapNudge(iteration.tokens, maxTokens),
        reason: 'completion signal fired under loop token cap',
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

  // B5 / T6 / T39: write HANDOFF.json, then a capped path+hash note.
  let rehydrated = false;
  const shouldRehydrate = Boolean(options.childResult.contextCompacted)
    || Boolean(decision.rehydrate && decision.rehydrate.length > 0);
  if (shouldRehydrate) {
    try {
      const dest = await writeLoopHandoff({
        state: options.state,
        iteration: options.iteration,
        childResult: options.childResult,
      });
      const content = decision.rehydrate && decision.rehydrate.length > 0
        ? await loadRehydrationNote(decision.rehydrate)
        : '';
      const parts = [
        dest ? `Read \`${dest}\` first (goal and open ledger ids).` : '',
        content.trim(),
      ].filter(Boolean);
      if (parts.length > 0) {
        options.state.pendingInterventions.push(
          createLoopPendingInput(
            clipHandoffInjectNote(
              `Restored working set (context was just reset to a fresh session):\n\n${parts.join('\n\n')}`,
            ),
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
