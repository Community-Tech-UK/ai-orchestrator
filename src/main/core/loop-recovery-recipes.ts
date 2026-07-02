/**
 * Named recovery recipes (spec C3 / #16)
 *
 * A small CLOSED catalog of loop-relevant recovery recipes keyed by the
 * `FailoverReason` produced by `classifyLoopError` (loop-error-classification.ts).
 * Each recipe describes an ordered list of steps and enforces **exactly one**
 * automatic recovery attempt per recipe per loop run before escalating to the
 * loop's existing BLOCKED/pause path.
 *
 * This module is a *decider*, not an executor of destructive git operations:
 * - `safe` steps are auto-runnable (e.g. retry, restore checkpoint, route to
 *   compaction — the actual compaction mechanics already live in
 *   `loop-invocation-error-routing.ts` / Workstream B; this module only names
 *   and annotates that route, it does not duplicate it).
 * - `destructive` steps (anything that can lose work: `git reset --hard`,
 *   `git rebase`, `git clean`, branch deletion, force-checkout, discarding a
 *   dirty worktree) are **never auto-run**. They are only ever PROPOSED as a
 *   recommendation for the operator, gated on `LoopConfig.allowDestructiveOps`
 *   for whether the proposal is even surfaced — the executor refuses to
 *   auto-run a destructive step regardless of that flag's value. See the
 *   spec's "No auto-destructive git" correction box (§4 C3).
 *
 * Classifications with no entry in the catalog are untouched — callers must
 * preserve their existing fallback behavior (this module exposes `undefined`
 * for those, it never invents a recipe).
 */

import type { FailoverReason } from './failover-error';
import { getLogger } from '../logging/logger';
import { RecoveryActionType } from '../../shared/types/error-recovery.types';

const logger = getLogger('LoopRecoveryRecipes');

/** Whether a recipe step is auto-runnable or must be proposed to the operator. */
export type RecoveryStepClass = 'safe' | 'destructive';

export interface RecoveryRecipeStep {
  /** Reuses the existing RecoveryActionType taxonomy from error-recovery.ts. */
  readonly type: RecoveryActionType;
  readonly class: RecoveryStepClass;
  /** Human-readable description shown in logs / BLOCKED.md / audit trail. */
  readonly description: string;
  /**
   * The exact command an operator would run for a `destructive` step. Never
   * executed by this module — surfaced so the escalation message can hand the
   * operator a copy-pasteable recommendation. Omitted for `safe` steps.
   */
  readonly command?: string;
}

export interface RecoveryRecipe {
  readonly steps: readonly RecoveryRecipeStep[];
  /** Always 1 — one automatic recovery attempt per recipe per loop run. */
  readonly maxAttempts: 1;
  readonly escalation: 'BLOCKED';
}

/**
 * The closed catalog. Keyed by `FailoverReason` (loop-error-classification.ts
 * already maps arbitrary errors onto this union, so recipes stay small and
 * stable). Do not key by raw error text — that would reopen an unbounded
 * catalog.
 */
const RECOVERY_RECIPE_CATALOG: ReadonlyMap<FailoverReason, RecoveryRecipe> = new Map<FailoverReason, RecoveryRecipe>([
  // mcp-handshake / provider adapter failures — a single retry is almost
  // always sufficient; if it recurs, escalate rather than hammering.
  ['provider_runtime', {
    steps: [
      { type: RecoveryActionType.RETRY, class: 'safe', description: 'Retry the provider invocation once with a fresh session' },
    ],
    maxAttempts: 1,
    escalation: 'BLOCKED',
  }],
  // context_overflow already routes to compaction in
  // loop-invocation-error-routing.ts (Workstream B). This recipe entry names
  // and annotates that existing route for the audit trail — it does not
  // perform compaction itself.
  ['context_overflow', {
    steps: [
      { type: RecoveryActionType.RESTART_SESSION, class: 'safe', description: 'Route to context compaction (handled by loop-invocation-error-routing.ts shouldCompress path)' },
    ],
    maxAttempts: 1,
    escalation: 'BLOCKED',
  }],
  // Transient prompt-delivery transport errors (broken pipe, EPIPE) — retry
  // once on a fresh session.
  ['prompt_delivery', {
    steps: [
      { type: RecoveryActionType.RETRY, class: 'safe', description: 'Retry prompt delivery once with a fresh session' },
    ],
    maxAttempts: 1,
    escalation: 'BLOCKED',
  }],
  // Tool execution failures — retry once; escalate if the tool keeps failing.
  ['tool_runtime', {
    steps: [
      { type: RecoveryActionType.RETRY, class: 'safe', description: 'Retry the failed tool call once' },
    ],
    maxAttempts: 1,
    escalation: 'BLOCKED',
  }],
  // Session replay/resume failures — restore the latest checkpoint (safe,
  // read-only against history) then retry once.
  ['session_resume', {
    steps: [
      { type: RecoveryActionType.RESTORE_CHECKPOINT, class: 'safe', description: 'Restore the latest session checkpoint' },
      { type: RecoveryActionType.RETRY, class: 'safe', description: 'Retry the iteration from the restored checkpoint' },
    ],
    maxAttempts: 1,
    escalation: 'BLOCKED',
  }],
  // Stale/dirty worktree or branch drift — the only automatic step is a
  // non-destructive report; the actual reset/rebase/clean is proposed for
  // operator approval and NEVER auto-run, per the spec's correction box.
  ['stale_worktree', {
    steps: [
      { type: RecoveryActionType.NOTIFY_USER, class: 'safe', description: 'Report stale/dirty worktree state (fetch + fast-forward check only, no mutation)' },
      { type: RecoveryActionType.RESTART_SESSION, class: 'destructive', description: 'Discard local changes and reset the worktree to match the remote branch', command: 'git fetch origin && git reset --hard origin/<branch> && git clean -fd' },
    ],
    maxAttempts: 1,
    escalation: 'BLOCKED',
  }],
]);

export function getRecoveryRecipe(reason: FailoverReason): RecoveryRecipe | undefined {
  return RECOVERY_RECIPE_CATALOG.get(reason);
}

/** Attempt bookkeeping: one Set of reasons already attempted per loop run. */
const attemptedRecipesByLoopRun = new Map<string, Set<FailoverReason>>();

export interface RecoveryAttemptRecord {
  readonly loopRunId: string;
  readonly seq: number;
  readonly reason: FailoverReason;
  readonly attemptNumber: number;
  readonly outcome: 'attempted' | 'escalated' | 'no-recipe';
  readonly steps: readonly RecoveryRecipeStep[];
  /** Destructive steps proposed to the operator (never executed). Empty when none. */
  readonly proposedDestructiveSteps: readonly RecoveryRecipeStep[];
  readonly timestamp: number;
}

export interface RecoveryRecipeDecisionParams {
  readonly loopRunId: string;
  readonly seq: number;
  readonly reason: FailoverReason;
  /** LoopConfig.allowDestructiveOps — gates whether destructive steps are even
   *  surfaced as a proposal. Even when true, they are still never auto-run. */
  readonly allowDestructiveOps: boolean;
}

export type RecoveryRecipeDecisionKind = 'no-recipe' | 'attempt' | 'escalate';

export interface RecoveryRecipeDecision {
  readonly kind: RecoveryRecipeDecisionKind;
  /** Present when kind !== 'no-recipe'. */
  readonly recipe?: RecoveryRecipe;
  /** Safe steps the caller may run automatically. Empty unless kind === 'attempt'. */
  readonly safeSteps: readonly RecoveryRecipeStep[];
  /** Destructive steps, always PROPOSED — never to be auto-run by any caller,
   *  regardless of `allowDestructiveOps`. Populated only when
   *  `allowDestructiveOps` is true and the recipe has destructive steps. */
  readonly proposedDestructiveSteps: readonly RecoveryRecipeStep[];
  readonly record: RecoveryAttemptRecord;
}

/**
 * Consult the recipe catalog for a classified loop error and decide whether
 * to run the recipe's safe steps or escalate.
 *
 * - Unknown/uncatalogued reasons return `kind: 'no-recipe'` — callers must
 *   fall through to their existing behavior unchanged.
 * - The first time a given (loopRunId, reason) pair is seen, returns
 *   `kind: 'attempt'` with the recipe's `safe` steps (and any destructive
 *   steps as PROPOSALS only, when `allowDestructiveOps` is true).
 * - Every subsequent time the same (loopRunId, reason) pair is seen, returns
 *   `kind: 'escalate'` — the recipe's one automatic attempt has already been
 *   used. The caller is responsible for actually escalating to the
 *   BLOCKED/pause path; this function only exposes the decision.
 *
 * Every call emits a structured audit record (returned on the decision, and
 * logged) so the caller can attach it to the iteration log.
 */
export function decideRecoveryRecipe(params: RecoveryRecipeDecisionParams): RecoveryRecipeDecision {
  const { loopRunId, seq, reason, allowDestructiveOps } = params;
  const recipe = getRecoveryRecipe(reason);

  if (!recipe) {
    const record: RecoveryAttemptRecord = {
      loopRunId,
      seq,
      reason,
      attemptNumber: 0,
      outcome: 'no-recipe',
      steps: [],
      proposedDestructiveSteps: [],
      timestamp: Date.now(),
    };
    return { kind: 'no-recipe', safeSteps: [], proposedDestructiveSteps: [], record };
  }

  const safeSteps = recipe.steps.filter(step => step.class === 'safe');
  const destructiveSteps = recipe.steps.filter(step => step.class === 'destructive');
  const proposedDestructiveSteps = allowDestructiveOps ? destructiveSteps : [];

  let attempted = attemptedRecipesByLoopRun.get(loopRunId);
  if (!attempted) {
    attempted = new Set<FailoverReason>();
    attemptedRecipesByLoopRun.set(loopRunId, attempted);
  }

  const alreadyAttempted = attempted.has(reason);

  if (alreadyAttempted) {
    const record: RecoveryAttemptRecord = {
      loopRunId,
      seq,
      reason,
      attemptNumber: recipe.maxAttempts + 1,
      outcome: 'escalated',
      steps: recipe.steps,
      proposedDestructiveSteps,
      timestamp: Date.now(),
    };
    logger.warn('Recovery recipe already attempted once; escalating to BLOCKED', {
      loopRunId,
      seq,
      reason,
      escalation: recipe.escalation,
    });
    return { kind: 'escalate', recipe, safeSteps: [], proposedDestructiveSteps, record };
  }

  attempted.add(reason);
  const record: RecoveryAttemptRecord = {
    loopRunId,
    seq,
    reason,
    attemptNumber: 1,
    outcome: 'attempted',
    steps: recipe.steps,
    proposedDestructiveSteps,
    timestamp: Date.now(),
  };
  logger.info('Running recovery recipe (one automatic attempt)', {
    loopRunId,
    seq,
    reason,
    safeStepCount: safeSteps.length,
    proposedDestructiveStepCount: proposedDestructiveSteps.length,
  });
  return { kind: 'attempt', recipe, safeSteps, proposedDestructiveSteps, record };
}

/** Clear attempt bookkeeping for a loop run (call when the run ends). */
export function clearLoopRecoveryAttempts(loopRunId: string): void {
  attemptedRecipesByLoopRun.delete(loopRunId);
}

/** Test-only: reset all recipe attempt bookkeeping across every loop run. */
export function _resetRecoveryRecipesForTesting(): void {
  attemptedRecipesByLoopRun.clear();
}
