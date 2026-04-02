import { describe, it, expect } from 'vitest';
import { ContextCollapse, type CollapsibleTurn } from './context-collapse';

describe('ContextCollapse', () => {
  const makeTurn = (id: string, tokens: number, age: 'old' | 'recent'): CollapsibleTurn => ({
    id,
    role: 'assistant',
    content: `Response for ${id}`,
    tokenCount: tokens,
    timestamp: age === 'old' ? Date.now() - 600000 : Date.now(),
    collapsible: true,
  });

  it('stages collapses for old turns that exceed threshold', () => {
    const collapse = new ContextCollapse({ collapseAfterTurns: 2, minTokensToCollapse: 100 });
    const turns = [
      makeTurn('old1', 500, 'old'),
      makeTurn('old2', 300, 'old'),
      makeTurn('recent1', 200, 'recent'),
      makeTurn('recent2', 100, 'recent'),
    ];

    const staged = collapse.stageCollapses(turns);
    expect(staged.collapsedTurnIds).toContain('old1');
    expect(staged.collapsedTurnIds).toContain('old2');
    expect(staged.collapsedTurnIds).not.toContain('recent1');
    expect(staged.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it('applies staged collapses to produce compressed turns', () => {
    const collapse = new ContextCollapse({ collapseAfterTurns: 1, minTokensToCollapse: 50 });
    const turns = [
      makeTurn('old1', 500, 'old'),
      makeTurn('recent1', 200, 'recent'),
    ];

    const staged = collapse.stageCollapses(turns);
    const applied = collapse.applyCollapses(turns, staged);

    // Old turn should be collapsed to a brief summary marker
    expect(applied.turns[0].content).toContain('[collapsed');
    expect(applied.turns[0].tokenCount).toBeLessThan(500);
    // Recent turn untouched
    expect(applied.turns[1].content).toBe('Response for recent1');
  });

  it('can recover from overflow by force-collapsing more aggressively', () => {
    const collapse = new ContextCollapse({ collapseAfterTurns: 3, minTokensToCollapse: 100 });
    const turns = [
      makeTurn('a', 1000, 'old'),
      makeTurn('b', 1000, 'old'),
      makeTurn('c', 1000, 'recent'),
    ];

    const result = collapse.recoverFromOverflow(turns);
    // Should collapse even "recent" turns when recovering from overflow
    expect(result.collapsedTurnIds.length).toBeGreaterThanOrEqual(2);
  });

  it('skips turns marked as not collapsible', () => {
    const collapse = new ContextCollapse({ collapseAfterTurns: 1, minTokensToCollapse: 0 });
    const turns: CollapsibleTurn[] = [
      { ...makeTurn('old1', 500, 'old'), collapsible: false },
      makeTurn('recent1', 200, 'recent'),
    ];

    const staged = collapse.stageCollapses(turns);
    expect(staged.collapsedTurnIds).not.toContain('old1');
  });
});
