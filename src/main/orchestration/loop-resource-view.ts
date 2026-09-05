/**
 * B1 — provider-neutral resource view for loop spend.
 *
 * Two numbers in this codebase have repeatedly been confused for each other:
 *
 *   - **Run budget** — `caps.maxTokens` / `caps.maxCostCents`. What this run is
 *     allowed to spend in total. Usually `null` (unbounded, deliberately).
 *   - **Context capacity** — how much of the model's window a session is
 *     currently occupying. Only ever known when the provider reports a
 *     current-window sample.
 *
 * Borrowing one as the other is what produced "3500% utilisation" and the
 * phantom `/ 1000000` budget line. This module keeps them in separate types
 * that cannot be assigned to each other, and makes "unknown" a first-class
 * state rather than a zero.
 *
 * It also gives every non-child spend a *purpose*, so a bill can be read as
 * "62% builder, 31% reviewer, 7% verify" instead of one opaque total, and
 * preserves whether each number was provider-reported or computed locally.
 *
 * Wave 1 lands the types and the pure builder. Wave 4 (T9/B1) migrates the
 * existing call sites onto them.
 */

/** Where a number came from. Never let a local estimate masquerade as a bill. */
export type LoopUsageProvenance =
  /** The provider reported this figure for this call. */
  | 'provider-reported'
  /** Computed here from a provider-reported token breakdown and a price table. */
  | 'computed'
  /** A legacy flat-rate estimate with no usage breakdown behind it. */
  | 'legacy-estimate';

/** What a spend was for. */
export type LoopSpendPurpose =
  | 'builder'
  | 'review'
  | 'verify'
  | 'context-action'
  | 'classification'
  | 'housekeeping';

/** Token split. Every field is optional because providers report different subsets. */
export interface LoopTokenBreakdown {
  input?: number;
  output?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Total as reported/derived. Present even when the split is not. */
  total: number;
}

export interface LoopSpendEntry {
  purpose: LoopSpendPurpose;
  /** Free-text detail, e.g. `ping-pong round 3`, `quick-verify`. */
  detail?: string;
  tokens: LoopTokenBreakdown;
  costCents: number | null;
  provenance: LoopUsageProvenance;
  /** Model that produced the spend, when known. */
  model?: string;
  at: number;
}

/**
 * Whole-run budget. Explicitly NOT a context window: `null` means unbounded,
 * and unbounded is the shipped default (a finite default ended real multi-hour
 * runs and was reverted on 2026-09-02).
 */
export interface LoopRunBudget {
  maxTokens: number | null;
  maxCostCents: number | null;
  usedTokens: number;
  usedCostCents: number;
}

/**
 * Context capacity for the live session. `status` is the load-bearing field:
 * a `known` capacity requires a provider-reported current-window sample.
 * Cumulative token sums, HUD estimates and catalog windows are NOT occupancy.
 */
export type LoopContextCapacity =
  | { status: 'unknown'; reason: string }
  | {
      status: 'known';
      usedTokens: number;
      windowTokens: number;
      /** Fraction in [0, 1]. Derived, never supplied. */
      utilization: number;
      provenance: Extract<LoopUsageProvenance, 'provider-reported'>;
    };

/** A context action (recycle, compaction, rehydrate) with why it happened. */
export interface LoopContextActionRecord {
  action: 'recycle' | 'rehydrate' | 'handoff' | 'reset' | 'none';
  purpose: string;
  /** How sure the decision was, 0–1. A ceiling recycle is deliberately low. */
  confidence: number;
  before: LoopContextCapacity;
  after: LoopContextCapacity;
  at: number;
}

export interface LoopResourceView {
  budget: LoopRunBudget;
  capacity: LoopContextCapacity;
  spend: LoopSpendEntry[];
  contextActions: LoopContextActionRecord[];
}

/** The only legal way to say "we do not know the occupancy". */
export function unknownCapacity(reason: string): LoopContextCapacity {
  return { status: 'unknown', reason };
}

/**
 * Build a `known` capacity from a provider-reported sample. Returns `unknown`
 * rather than a fabricated percentage when the sample is unusable — a zero or
 * absent window is the "catalog 200k became a recycle percentage" trap.
 */
export function knownCapacity(usedTokens: number, windowTokens: number): LoopContextCapacity {
  if (!Number.isFinite(usedTokens) || !Number.isFinite(windowTokens) || windowTokens <= 0) {
    return unknownCapacity('provider sample had no usable window');
  }
  if (usedTokens < 0) return unknownCapacity('provider sample reported negative usage');
  return {
    status: 'known',
    usedTokens,
    windowTokens,
    utilization: usedTokens / windowTokens,
    provenance: 'provider-reported',
  };
}

/** Sum a spend list by purpose. Costs stay `null` when nothing was priced. */
export function summarizeSpendByPurpose(
  spend: readonly LoopSpendEntry[],
): Record<LoopSpendPurpose, { tokens: number; costCents: number | null }> {
  const empty = (): { tokens: number; costCents: number | null } => ({ tokens: 0, costCents: null });
  const out: Record<LoopSpendPurpose, { tokens: number; costCents: number | null }> = {
    builder: empty(),
    review: empty(),
    verify: empty(),
    'context-action': empty(),
    classification: empty(),
    housekeeping: empty(),
  };
  for (const entry of spend) {
    const bucket = out[entry.purpose];
    bucket.tokens += entry.tokens.total;
    if (entry.costCents !== null) {
      bucket.costCents = (bucket.costCents ?? 0) + entry.costCents;
    }
  }
  return out;
}

/**
 * Fraction of the run budget consumed, or `null` when the budget is unbounded.
 * Never substitute a context window here: an unbounded run has no percentage,
 * and printing one against `DEFAULT_CONTEXT_BUDGET_TOKENS` is the phantom-1M
 * dishonesty T24 removed.
 */
export function budgetUtilization(budget: LoopRunBudget): { tokens: number | null; cost: number | null } {
  return {
    tokens: budget.maxTokens && budget.maxTokens > 0 ? budget.usedTokens / budget.maxTokens : null,
    cost: budget.maxCostCents && budget.maxCostCents > 0 ? budget.usedCostCents / budget.maxCostCents : null,
  };
}
