/**
 * Tool-pair repair — orphaned tool_use/tool_result invariant.
 *
 * Compaction's "keep last N" cut (the summarize path) slices a turn array
 * in two: an old side that gets summarized away and a retained side that
 * survives verbatim. If the cut lands between a `tool_use` and its
 * matching `tool_result`, the retained side ships a dangling tool call
 * that most provider APIs (Anthropic in particular) reject outright.
 *
 * These are pure functions — no I/O, no logging, no mutation of inputs —
 * so callers can slot them into any "build a retained/compacted message
 * list by cutting" path without pulling in class state.
 *
 * Borrowed from openclaw's `repairToolUseResultPairing`
 * (`compaction-planning.ts:382` / `session-transcript-repair.ts:584`).
 * Two pairing shapes are supported so this works with every turn model in
 * this codebase:
 *
 *  1. **Atomic** (`ConversationTurn.toolCalls[]`, `CollapsibleTurn`):
 *     a `tool_use` and its `tool_result` live on the same `toolCalls[]`
 *     entry — `output` present means paired, `output === undefined` means
 *     the call is still dangling (no result captured on this record yet).
 *  2. **Split** (raw provider message streams that represent a `tool_use`
 *     and its `tool_result` as two separate turns): a turn declares itself
 *     a tool_result for a given call id via `toolResultFor`; the matching
 *     `tool_use` is a `toolCalls[]` entry with that same id and no output
 *     on some earlier turn.
 */

/** Minimal shape of a tool call record needed to check pairing. */
export interface ToolPairCall {
  id: string;
  output?: string;
}

/** Minimal shape of a turn/message needed to check tool-pair invariants. */
export interface ToolPairTurn {
  id: string;
  /** Atomic tool_use(+optional tool_result) records issued by this turn. */
  toolCalls?: ToolPairCall[];
  /** Set when this turn IS a tool_result for a tool_use issued elsewhere. */
  toolResultFor?: string;
}

/** A single orphan found by {@link findOrphanedToolCalls}. */
export interface OrphanedToolCall {
  turnId: string;
  toolCallId: string;
  /** 'dangling-use' = tool_use with no result anywhere in the list; 'stranded-result' = tool_result with no tool_use in the list. */
  kind: 'dangling-use' | 'stranded-result';
}

/**
 * Find every tool call that is missing its pair within `turns`:
 * - a `toolCalls[]` entry with `output === undefined` and no matching
 *   `toolResultFor` turn elsewhere in the list ("dangling-use"), or
 * - a `toolResultFor` turn whose matching `toolCalls[]` entry (by id)
 *   does not appear anywhere in the list ("stranded-result").
 *
 * Pure — does not mutate `turns`.
 */
export function findOrphanedToolCalls<T extends ToolPairTurn>(turns: readonly T[]): OrphanedToolCall[] {
  const useTurnById = new Map<string, T>();
  const resultTurnById = new Map<string, T>();

  for (const turn of turns) {
    for (const call of turn.toolCalls ?? []) {
      useTurnById.set(call.id, turn);
    }
    if (turn.toolResultFor) {
      resultTurnById.set(turn.toolResultFor, turn);
    }
  }

  const orphans: OrphanedToolCall[] = [];

  for (const turn of turns) {
    for (const call of turn.toolCalls ?? []) {
      const hasAtomicResult = call.output !== undefined;
      const hasSplitResult = resultTurnById.has(call.id);
      if (!hasAtomicResult && !hasSplitResult) {
        orphans.push({ turnId: turn.id, toolCallId: call.id, kind: 'dangling-use' });
      }
    }
    if (turn.toolResultFor && !useTurnById.has(turn.toolResultFor)) {
      orphans.push({ turnId: turn.id, toolCallId: turn.toolResultFor, kind: 'stranded-result' });
    }
  }

  return orphans;
}

/**
 * Invariant assertion: throws if any turn in `turns` carries a `tool_use`
 * without a matching `tool_result` (or vice versa). Intended to run after
 * a compaction cut (or in tests) to catch regressions before a corrupt
 * turn list reaches a provider adapter.
 */
export function assertNoOrphanedToolResults<T extends ToolPairTurn>(turns: readonly T[]): void {
  const orphans = findOrphanedToolCalls(turns);
  if (orphans.length > 0) {
    const details = orphans.map(o => `${o.kind}:${o.turnId}:${o.toolCallId}`).join(', ');
    throw new Error(`Orphaned tool_use/tool_result pairing found in retained turns: ${details}`);
  }
}

/** Result of {@link repairOrphanedToolPairs}. */
export interface ToolPairRepairResult<T extends ToolPairTurn> {
  /** The retained turns, with any stranded tool calls/results dropped. */
  turns: T[];
  /** How far the cut boundary was walked backward (0 = no change). */
  boundaryShift: number;
  /** Tool calls/results that were dropped because their pair could not be completed. */
  dropped: OrphanedToolCall[];
}

/**
 * Repair a "keep last N" cut so the retained side never ships an orphaned
 * tool call.
 *
 * `turns` is the full ordered list; `cutIndex` is the index (0-based) where
 * the retained slice begins — i.e. the caller's intended
 * `retained = turns.slice(cutIndex)`. The boundary is walked backward
 * (pulling earlier turns into the retained side) while doing so resolves
 * an orphan currently at the front of the retained slice — this is what
 * keeps a `tool_use` turn together with a `tool_result` turn that
 * immediately follows it when a naive cut would otherwise split them.
 * Any tool call that still can't be paired after the walk is dropped
 * (the `toolCalls` entry, or the whole `toolResultFor` turn, is removed)
 * rather than shipped broken.
 *
 * Pure — returns new arrays/objects, never mutates `turns` or its turns.
 */
export function repairOrphanedToolPairs<T extends ToolPairTurn>(
  turns: readonly T[],
  cutIndex: number,
): ToolPairRepairResult<T> {
  const clampedCut = Math.max(0, Math.min(cutIndex, turns.length));

  let boundary = clampedCut;
  while (boundary > 0) {
    const retainedSlice = turns.slice(boundary);
    const orphans = findOrphanedToolCalls(retainedSlice);
    if (orphans.length === 0) break;

    const priorTurn = turns[boundary - 1];
    const priorCallIds = new Set((priorTurn.toolCalls ?? []).map(c => c.id));
    const priorResultFor = priorTurn.toolResultFor;

    const priorResolvesAnOrphan = orphans.some(
      o =>
        (o.kind === 'stranded-result' && priorCallIds.has(o.toolCallId)) ||
        (o.kind === 'dangling-use' && priorResultFor === o.toolCallId),
    );
    if (!priorResolvesAnOrphan) break;

    boundary -= 1;
  }

  const retained = turns.slice(boundary).map(t => ({ ...t }));
  const stillOrphaned = findOrphanedToolCalls(retained);
  const dropped: OrphanedToolCall[] = [];

  const orphanedResultTurnIds = new Set(
    stillOrphaned.filter(o => o.kind === 'stranded-result').map(o => o.turnId),
  );
  const orphanedUseCallIds = new Set(
    stillOrphaned.filter(o => o.kind === 'dangling-use').map(o => o.toolCallId),
  );

  const repaired: T[] = [];
  for (const turn of retained) {
    if (turn.toolResultFor && orphanedResultTurnIds.has(turn.id)) {
      dropped.push({ turnId: turn.id, toolCallId: turn.toolResultFor, kind: 'stranded-result' });
      continue; // drop the entire stranded tool_result turn
    }

    if (turn.toolCalls && turn.toolCalls.some(c => orphanedUseCallIds.has(c.id))) {
      const keptCalls = turn.toolCalls.filter(call => {
        if (!orphanedUseCallIds.has(call.id)) return true;
        dropped.push({ turnId: turn.id, toolCallId: call.id, kind: 'dangling-use' });
        return false;
      });
      repaired.push({ ...turn, toolCalls: keptCalls.length > 0 ? keptCalls : undefined });
      continue;
    }

    repaired.push(turn);
  }

  return {
    turns: repaired,
    boundaryShift: clampedCut - boundary,
    dropped,
  };
}
