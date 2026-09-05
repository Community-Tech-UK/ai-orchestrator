import { describe, expect, it } from 'vitest';

import { buildAwayRecap, classifyAwayOutcome } from './away-recap';
import type { LoopRunSummary } from '../../shared/types/loop-stream.types';

const AWAY_SINCE = 1_000_000;
const NOW = AWAY_SINCE + 8 * 3_600_000;

function run(over: Partial<LoopRunSummary> = {}): LoopRunSummary {
  return {
    id: `run-${Math.random()}`,
    chatId: 'chat-1',
    status: 'completed',
    totalIterations: 4,
    totalTokens: 1_000,
    totalCostCents: 25,
    startedAt: AWAY_SINCE + 1_000,
    endedAt: AWAY_SINCE + 3_600_000,
    endReason: 'verify passed',
    workspaceCwd: '/repo',
    initialPrompt: 'Fix the login flow',
    iterationPrompt: null,
    openOutstandingCount: 0,
    ...over,
  } as LoopRunSummary;
}

describe('classifyAwayOutcome (N12)', () => {
  it('treats a clean completion as finished', () => {
    expect(classifyAwayOutcome(run({ status: 'completed' }))).toBe('finished');
  });

  it('separates "ran out of road" from "broke"', () => {
    for (const status of ['no-progress', 'cap-reached', 'cost-exceeded'] as const) {
      expect(classifyAwayOutcome(run({ status })), status).toBe('stopped-short');
    }
    for (const status of ['error', 'failed'] as const) {
      expect(classifyAwayOutcome(run({ status })), status).toBe('needs-you');
    }
  });

  /**
   * `completed-needs-review` is a SUCCESS state, but it is still asking for a
   * person, and that is the axis this recap sorts on.
   */
  it('counts completed-needs-review as needing you', () => {
    expect(classifyAwayOutcome(run({ status: 'completed-needs-review' }))).toBe('needs-you');
  });
});

describe('buildAwayRecap (N12)', () => {
  it('says nothing when nothing ended while you were away', () => {
    expect(buildAwayRecap({ runs: [], awaySince: AWAY_SINCE, now: NOW })).toBeNull();
  });

  it('ignores runs that ended before you left', () => {
    const old = run({ endedAt: AWAY_SINCE - 1 });
    expect(buildAwayRecap({ runs: [old], awaySince: AWAY_SINCE, now: NOW })).toBeNull();
  });

  it('ignores runs that are still going', () => {
    const live = run({ status: 'running', endedAt: null });
    expect(buildAwayRecap({ runs: [live], awaySince: AWAY_SINCE, now: NOW })).toBeNull();
  });

  /** "3 finished" is a worse first sentence than "1 needs you" when both are true. */
  it('leads the headline with what needs a person', () => {
    const recap = buildAwayRecap({
      runs: [run(), run(), run({ status: 'error' })],
      awaySince: AWAY_SINCE,
      now: NOW,
    });
    expect(recap!.headline).toContain('1 needs you');
    expect(recap!.headline.indexOf('needs you')).toBeLessThan(recap!.headline.indexOf('finished'));
  });

  it('sorts cards so the ones wanting attention come first', () => {
    const recap = buildAwayRecap({
      runs: [run({ status: 'completed' }), run({ status: 'cap-reached' }), run({ status: 'failed' })],
      awaySince: AWAY_SINCE,
      now: NOW,
    });
    expect(recap!.cards.map((c) => c.outcome)).toEqual(['needs-you', 'stopped-short', 'finished']);
  });

  it('totals the cost across runs so the overnight bill is one number', () => {
    const recap = buildAwayRecap({
      runs: [run({ totalCostCents: 100 }), run({ totalCostCents: 250 })],
      awaySince: AWAY_SINCE,
      now: NOW,
    });
    expect(recap!.totalCostCents).toBe(350);
  });

  it('carries the outstanding count so open questions are not lost', () => {
    const recap = buildAwayRecap({
      runs: [run({ openOutstandingCount: 3 })],
      awaySince: AWAY_SINCE,
      now: NOW,
    });
    expect(recap!.cards[0]!.outstandingCount).toBe(3);
  });

  it('clips a long goal and never renders an empty title', () => {
    const recap = buildAwayRecap({
      runs: [run({ initialPrompt: 'g'.repeat(400) }), run({ initialPrompt: '   ' })],
      awaySince: AWAY_SINCE,
      now: NOW,
    });
    const goals = recap!.cards.map((c) => c.goal);
    expect(goals.some((g) => g.endsWith('…'))).toBe(true);
    expect(goals).toContain('Untitled run');
  });

  it('gets the singular right for a single run', () => {
    const recap = buildAwayRecap({ runs: [run()], awaySince: AWAY_SINCE, now: NOW });
    expect(recap!.headline).toContain('1 loop run ended');
  });
});
