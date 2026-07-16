/**
 * Ledger convergence tracking — the non-convergence backstop (WS3).
 *
 * The review-driven stall guard in the coordinator resets its counter whenever
 * an iteration makes ANY production file change, so a loop that edits files
 * every round but never CLOSES a `LOOP_TASKS.md` item looks productive forever.
 * The first backstop (historical-minimum open count) fixed that, but it had its
 * own false-stall failure: a raw open count that RISES while distinct leaves
 * resolve (the worker discovers new tasks as fast as it closes old ones) never
 * reaches a new low, so real progress read as a stall.
 *
 * Observed: loop-1782864004679 oscillated 6 → 2 → 9 → 5 → 4 (never converging,
 * true stall); a later loop closed distinct WS leaves every round while its
 * count plateaued at 4 (false stall, killed after 8 iterations).
 *
 * This module therefore tracks whether KNOWN LEAF TASKS actually transition
 * (WS2 gives leaves stable ids). The first non-empty snapshot freezes the
 * planned inventory; later ids are recorded as discovered — still required for
 * completion, but their arrival can never erase the history of previously
 * resolved work. A stall is "no meaningful transition for N iterations", not
 * "no new minimum".
 *
 * Meaningful transitions:
 *   - a known leaf moves from todo/doing to done, or to deferred WITH a reason;
 *   - a known leaf moves from todo to doing — once per task (recorded states
 *     never move backward, so a later regression cannot re-arm the credit);
 *   - a previously duplicate/malformed id inventory becomes valid; or
 *   - a new, unique objective-evidence key (passing verification run, strictly
 *     higher test-pass count) appears.
 *
 * NOT meaningful: text edits without a state change, newly discovered tasks,
 * raw file churn, repeated evidence, or backward transitions (those stay
 * visible as warnings and keep the counter advancing). Removing an unresolved
 * task from the ledger is not completion — it stays in the known inventory as
 * unresolved and produces a warning.
 *
 * Pure module — no I/O — so it is trivially unit-tested and shared.
 */

import type {
  LedgerConvergenceState,
  LoopLedgerTaskState,
} from '../../shared/types/loop-state.types';
import type { LoopTaskLedger } from './loop-task-ledger';

/**
 * Default backstop: 8 consecutive iterations without a meaningful task
 * transition. High enough that lumpy-but-real progress (an item that
 * legitimately takes several iterations to close) never trips it; low enough
 * that a non-convergent loop stops well before the hard iteration cap.
 */
export const DEFAULT_MAX_LEDGER_STALL_ITERATIONS = 8;

/** Forward-progress rank per state. `done` and `deferred` are both terminal. */
const STATE_RANK: Record<LoopLedgerTaskState, number> = {
  todo: 0,
  doing: 1,
  done: 2,
  deferred: 2,
};

export interface LedgerConvergenceUpdate {
  next: LedgerConvergenceState;
  /** True when this snapshot contained at least one meaningful transition. */
  meaningfulTransition: boolean;
  /** Human-readable convergence warnings (backward moves, removed-unresolved). */
  warnings: string[];
}

/** Inputs for the objective-evidence dedup key. */
export interface LedgerObjectiveEvidenceInput {
  /** Verification runs recorded for this loop so far (any order). */
  verificationRuns: readonly { id: string; exitCode: number | null; startedAt: number }[];
  /** This iteration's reported test pass count (null when unknown). */
  testPassCount: number | null;
  /** The highest test pass count BEFORE this iteration was folded in. */
  previousHighestTestPassCount: number;
}

/**
 * Derive the objective-evidence dedup key for an iteration: the newest PASSING
 * verification run, else a strictly-higher test-pass count. Returns null when
 * neither exists. Uniqueness comes from run ids / count monotonicity; the
 * tracker compares against `lastObjectiveEvidenceKey` so repeating the same
 * evidence never counts twice.
 */
export function computeObjectiveEvidenceKey(input: LedgerObjectiveEvidenceInput): string | null {
  let newestPass: { id: string; startedAt: number } | null = null;
  for (const run of input.verificationRuns) {
    if (run.exitCode !== 0) continue;
    if (!newestPass || run.startedAt > newestPass.startedAt) newestPass = run;
  }
  if (newestPass) return `verify-pass:${newestPass.id}`;
  if (
    typeof input.testPassCount === 'number'
    && input.testPassCount > input.previousHighestTestPassCount
  ) {
    return `tests:${input.testPassCount}`;
  }
  return null;
}

/**
 * Fold a ledger snapshot into the convergence tracker.
 *
 * When `previous` is undefined the first NON-EMPTY snapshot initializes the
 * tracker (this is also the migration point for old checkpoints that carry
 * only the legacy count fields — the transition counter starts fresh because
 * the legacy counter measured a different, false-stall-prone quantity).
 * An empty ledger never initializes or advances the tracker.
 */
export function updateLedgerConvergence(
  previous: LedgerConvergenceState | undefined,
  ledger: LoopTaskLedger,
  objectiveEvidenceKey: string | null,
): LedgerConvergenceUpdate | null {
  const leaves = ledger.items.filter((item) => item.leaf);
  if (leaves.length === 0 && !previous) return null;

  const inventoryInvalid = ledger.duplicateIds.length > 0 || ledger.malformedIds.length > 0;

  if (!previous) {
    // First non-empty snapshot: freeze the planned inventory. For duplicate
    // ids, keep the LEAST-progressed state so completion cannot be faked.
    const knownTaskStates: Record<string, LoopLedgerTaskState> = {};
    for (const leaf of leaves) {
      const existing = knownTaskStates[leaf.id];
      if (existing === undefined || STATE_RANK[leaf.state] < STATE_RANK[existing]) {
        knownTaskStates[leaf.id] = leaf.state;
      }
    }
    return {
      next: {
        version: 1,
        knownTaskStates,
        plannedLeafIds: [...new Set(leaves.map((l) => l.id))],
        discoveredLeafIds: [],
        noMeaningfulTransitionIterations: 0,
        ...(objectiveEvidenceKey ? { lastObjectiveEvidenceKey: objectiveEvidenceKey } : {}),
        ...(inventoryInvalid ? { inventoryInvalid: true } : {}),
      },
      meaningfulTransition: true,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  let meaningful = false;
  const knownTaskStates: Record<string, LoopLedgerTaskState> = { ...previous.knownTaskStates };
  const plannedSet = new Set<string>(previous.plannedLeafIds);
  const discovered = new Set<string>(previous.discoveredLeafIds);
  const seenLeafIds = new Set<string>();

  for (const leaf of leaves) {
    // Duplicate ids: track the least-progressed occurrence (fail-safe).
    if (seenLeafIds.has(leaf.id)) {
      const recorded = knownTaskStates[leaf.id];
      if (recorded !== undefined && STATE_RANK[leaf.state] < STATE_RANK[recorded]) {
        knownTaskStates[leaf.id] = leaf.state;
      }
      continue;
    }
    seenLeafIds.add(leaf.id);

    const prevState = previous.knownTaskStates[leaf.id];
    if (prevState === undefined) {
      // Newly discovered task: required for completion, but its arrival is
      // NOT a meaningful transition (it cannot erase resolved-work history).
      knownTaskStates[leaf.id] = leaf.state;
      if (!plannedSet.has(leaf.id)) discovered.add(leaf.id);
      continue;
    }

    const prevRank = STATE_RANK[prevState];
    const curRank = STATE_RANK[leaf.state];
    if (curRank > prevRank) {
      knownTaskStates[leaf.id] = leaf.state;
      if (leaf.state === 'done') {
        meaningful = true;
      } else if (leaf.state === 'deferred') {
        // Only a VALID deferral (with a reason) counts as resolution progress.
        if (leaf.reason.trim().length > 0) meaningful = true;
        else warnings.push(`task ${leaf.id} deferred without a reason — not counted as progress`);
      } else if (prevState === 'todo' && leaf.state === 'doing') {
        // Once per task: recorded states never move backward, so this fires
        // at most once for a given id.
        meaningful = true;
      }
    } else if (curRank < prevRank) {
      // Backward transition: keep the recorded (max-progress) state so the
      // credit cannot be re-armed, surface it, and let the counter advance.
      warnings.push(`task ${leaf.id} moved backward (${prevState} → ${leaf.state}) — regression is not progress`);
    } else if (leaf.state !== prevState) {
      // Same rank, different terminal label (done ↔ deferred): record, no credit.
      knownTaskStates[leaf.id] = leaf.state;
    }
  }

  // Tasks that vanished from the leaf set. A task whose id now appears as a
  // structural PARENT was refined into children (its leaves carry the work) —
  // drop it from the inventory. A genuinely removed unresolved task stays in
  // the inventory as unresolved: removal is not completion.
  const nonLeafIds = new Set<string>(ledger.items.filter((i) => !i.leaf).map((i) => i.id));
  for (const [id, recorded] of Object.entries(previous.knownTaskStates)) {
    if (seenLeafIds.has(id)) continue;
    if (nonLeafIds.has(id)) {
      delete knownTaskStates[id];
      continue;
    }
    if (STATE_RANK[recorded] < 2) {
      warnings.push(`unresolved task ${id} was removed from the ledger — removal is not completion; it remains required`);
    }
  }

  // A previously duplicate/malformed inventory becoming valid is a repair —
  // a meaningful transition in its own right.
  if (previous.inventoryInvalid && !inventoryInvalid) meaningful = true;

  // New, unique objective evidence (passing verify / higher test count).
  if (objectiveEvidenceKey && objectiveEvidenceKey !== previous.lastObjectiveEvidenceKey) {
    meaningful = true;
  }

  const next: LedgerConvergenceState = {
    version: 1,
    knownTaskStates,
    plannedLeafIds: previous.plannedLeafIds,
    discoveredLeafIds: [...discovered],
    noMeaningfulTransitionIterations: meaningful
      ? 0
      : previous.noMeaningfulTransitionIterations + 1,
    ...(objectiveEvidenceKey || previous.lastObjectiveEvidenceKey
      ? { lastObjectiveEvidenceKey: objectiveEvidenceKey ?? previous.lastObjectiveEvidenceKey }
      : {}),
    ...(inventoryInvalid ? { inventoryInvalid: true } : {}),
  };
  return { next, meaningfulTransition: meaningful, warnings };
}

/** Ids in the known inventory whose recorded state is still open (todo/doing). */
export function unresolvedKnownTaskIds(tracker: LedgerConvergenceState): string[] {
  return Object.entries(tracker.knownTaskStates)
    .filter(([, state]) => STATE_RANK[state] < 2)
    .map(([id]) => id);
}

/**
 * True when the ledger has stalled: unresolved known tasks remain and no
 * meaningful transition has occurred for `>= limit` consecutive iterations.
 * A fully-resolved inventory is never a stall — the completion gate owns that.
 */
export function isLedgerConvergenceStalled(
  tracker: LedgerConvergenceState | undefined,
  limit: number = DEFAULT_MAX_LEDGER_STALL_ITERATIONS,
): boolean {
  if (!tracker) return false;
  if (unresolvedKnownTaskIds(tracker).length === 0) return false;
  const effective = Math.max(1, Math.floor(limit));
  return tracker.noMeaningfulTransitionIterations >= effective;
}
