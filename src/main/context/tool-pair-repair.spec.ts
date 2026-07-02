import { describe, it, expect } from 'vitest';
import {
  assertNoOrphanedToolResults,
  findOrphanedToolCalls,
  repairOrphanedToolPairs,
  type ToolPairTurn,
} from './tool-pair-repair';

function turn(overrides: Partial<ToolPairTurn> & { id: string }): ToolPairTurn {
  return { ...overrides };
}

describe('findOrphanedToolCalls / assertNoOrphanedToolResults', () => {
  it('is a no-op (no orphans) on an already-valid list of plain turns', () => {
    const turns: ToolPairTurn[] = [
      turn({ id: 't1' }),
      turn({ id: 't2', toolCalls: [{ id: 'call-1', output: 'result text' }] }),
      turn({ id: 't3' }),
    ];

    expect(findOrphanedToolCalls(turns)).toEqual([]);
    expect(() => assertNoOrphanedToolResults(turns)).not.toThrow();
  });

  it('is a no-op when a tool_use and its split tool_result are both present', () => {
    const turns: ToolPairTurn[] = [
      turn({ id: 'assistant-1', toolCalls: [{ id: 'call-1' }] }), // no atomic output
      turn({ id: 'result-1', toolResultFor: 'call-1' }), // split tool_result turn
    ];

    expect(findOrphanedToolCalls(turns)).toEqual([]);
    expect(() => assertNoOrphanedToolResults(turns)).not.toThrow();
  });

  it('flags a dangling tool_use with no result anywhere in the list', () => {
    const turns: ToolPairTurn[] = [turn({ id: 't1', toolCalls: [{ id: 'call-1' }] })];

    const orphans = findOrphanedToolCalls(turns);
    expect(orphans).toEqual([{ turnId: 't1', toolCallId: 'call-1', kind: 'dangling-use' }]);
    expect(() => assertNoOrphanedToolResults(turns)).toThrow(/Orphaned tool_use\/tool_result/);
  });

  it('flags a stranded tool_result whose tool_use is missing', () => {
    const turns: ToolPairTurn[] = [turn({ id: 't1', toolResultFor: 'call-1' })];

    const orphans = findOrphanedToolCalls(turns);
    expect(orphans).toEqual([{ turnId: 't1', toolCallId: 'call-1', kind: 'stranded-result' }]);
    expect(() => assertNoOrphanedToolResults(turns)).toThrow(/Orphaned tool_use\/tool_result/);
  });
});

describe('repairOrphanedToolPairs', () => {
  it('no-ops on an already-valid retained slice (cut lands on a clean boundary)', () => {
    const turns: ToolPairTurn[] = [
      turn({ id: 't1' }),
      turn({ id: 't2' }),
      turn({ id: 't3', toolCalls: [{ id: 'call-1', output: 'ok' }] }),
      turn({ id: 't4' }),
    ];

    const result = repairOrphanedToolPairs(turns, 2);

    expect(result.boundaryShift).toBe(0);
    expect(result.dropped).toEqual([]);
    expect(result.turns.map(t => t.id)).toEqual(['t3', 't4']);
    expect(() => assertNoOrphanedToolResults(result.turns)).not.toThrow();
  });

  it('walks the cut boundary backward to keep a split tool_use/tool_result pair together', () => {
    const turns: ToolPairTurn[] = [
      turn({ id: 't1' }),
      turn({ id: 't2' }),
      turn({ id: 'assistant-1', toolCalls: [{ id: 'call-1' }] }), // tool_use, no atomic output
      turn({ id: 'result-1', toolResultFor: 'call-1' }), // its tool_result, in the NEXT turn
      turn({ id: 't5' }),
    ];

    // Naive cut of "keep last 2" would start at index 3 (`result-1`), which
    // is a stranded tool_result — its tool_use (`assistant-1`) sits just
    // before the boundary at index 2.
    const cutIndex = 3;
    const result = repairOrphanedToolPairs(turns, cutIndex);

    // Boundary walked back by 1 to include `assistant-1`.
    expect(result.boundaryShift).toBe(1);
    expect(result.turns.map(t => t.id)).toEqual(['assistant-1', 'result-1', 't5']);
    expect(result.dropped).toEqual([]);
    expect(() => assertNoOrphanedToolResults(result.turns)).not.toThrow();
  });

  it('drops a stranded tool_result when its tool_use was pruned (already absent from the caller-provided list)', () => {
    // Simulates the caller having already summarized away (removed) the
    // tool_use turn before invoking the repair pass — e.g. a prior
    // compaction round, or a transcript that never captured it. With no
    // tool_use anywhere in `turns`, walking the boundary back cannot help;
    // the stranded result must be dropped instead.
    const turns: ToolPairTurn[] = [
      turn({ id: 'result-1', toolResultFor: 'call-1' }), // tool_result with no matching tool_use in the list
      turn({ id: 't2' }),
      turn({ id: 't3' }),
    ];

    const cutIndex = 0;
    const result = repairOrphanedToolPairs(turns, cutIndex);

    expect(result.boundaryShift).toBe(0);
    expect(result.turns.map(t => t.id)).toEqual(['t2', 't3']);
    expect(result.dropped).toEqual([{ turnId: 'result-1', toolCallId: 'call-1', kind: 'stranded-result' }]);
    expect(() => assertNoOrphanedToolResults(result.turns)).not.toThrow();
  });

  it('drops a dangling atomic tool_use whose result never arrives in the retained slice', () => {
    const turns: ToolPairTurn[] = [
      turn({ id: 't1' }),
      turn({ id: 't2', toolCalls: [{ id: 'call-1' }] }), // no output captured, no split result turn
      turn({ id: 't3' }),
    ];

    const result = repairOrphanedToolPairs(turns, 1);

    expect(result.boundaryShift).toBe(0); // nothing before boundary resolves it
    expect(result.turns.map(t => t.id)).toEqual(['t2', 't3']);
    expect(result.turns[0].toolCalls).toBeUndefined();
    expect(result.dropped).toEqual([{ turnId: 't2', toolCallId: 'call-1', kind: 'dangling-use' }]);
    expect(() => assertNoOrphanedToolResults(result.turns)).not.toThrow();
  });

  it('preserves other toolCalls on a turn when only one call is orphaned', () => {
    const turns: ToolPairTurn[] = [
      turn({
        id: 't1',
        toolCalls: [
          { id: 'call-ok', output: 'done' },
          { id: 'call-orphan' },
        ],
      }),
    ];

    const result = repairOrphanedToolPairs(turns, 0);

    expect(result.turns[0].toolCalls).toEqual([{ id: 'call-ok', output: 'done' }]);
    expect(result.dropped).toEqual([{ turnId: 't1', toolCallId: 'call-orphan', kind: 'dangling-use' }]);
  });

  it('does not mutate the input turns array or its turns', () => {
    const original: ToolPairTurn[] = [
      turn({ id: 't1', toolCalls: [{ id: 'call-1' }] }),
      turn({ id: 't2', toolResultFor: 'call-1' }),
    ];
    const snapshot = JSON.parse(JSON.stringify(original));

    repairOrphanedToolPairs(original, 1);

    expect(original).toEqual(snapshot);
  });

  it('clamps an out-of-range cutIndex', () => {
    const turns: ToolPairTurn[] = [turn({ id: 't1' }), turn({ id: 't2' })];

    expect(repairOrphanedToolPairs(turns, 10).turns.map(t => t.id)).toEqual([]);
    expect(repairOrphanedToolPairs(turns, -5).turns.map(t => t.id)).toEqual(['t1', 't2']);
  });
});
