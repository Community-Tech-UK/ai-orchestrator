import { describe, it, expect } from 'vitest';
import {
  PolicyEngine,
  leaf,
  and,
  or,
  not,
  always,
  type Rule,
} from './policy-engine';

// A loop/merge-flavored facts shape, mirroring the scattered detectors #32 unifies.
interface LoopFacts {
  greenAt: boolean;
  staleBranch: boolean;
  reviewPassed: boolean;
  retryAvailable: boolean;
}

type LoopAction = 'merge' | 'rebase' | 'retry' | 'escalate' | 'wait';

const greenAt = leaf<LoopFacts>('GreenAt', (f) => f.greenAt);
const staleBranch = leaf<LoopFacts>('StaleBranch', (f) => f.staleBranch);
const reviewPassed = leaf<LoopFacts>('ReviewPassed', (f) => f.reviewPassed);
const retryAvailable = leaf<LoopFacts>('RetryAvailable', (f) => f.retryAvailable);

function engine(): PolicyEngine<LoopFacts, LoopAction> {
  const rules: Rule<LoopFacts, LoopAction>[] = [
    { id: 'merge-when-green-and-reviewed', priority: 100, action: 'merge', condition: and(greenAt, reviewPassed, not(staleBranch)) },
    { id: 'rebase-stale', priority: 90, action: 'rebase', condition: staleBranch },
    { id: 'retry-on-red', priority: 50, action: 'retry', condition: and(not(greenAt), retryAvailable) },
    { id: 'escalate-exhausted', priority: 40, action: 'escalate', condition: and(not(greenAt), not(retryAvailable)) },
    { id: 'default-wait', priority: 0, action: 'wait', condition: always() },
  ];
  return new PolicyEngine(rules);
}

describe('PolicyEngine', () => {
  it('selects the highest-priority matching rule', () => {
    const e = engine();
    expect(e.evaluate({ greenAt: true, staleBranch: false, reviewPassed: true, retryAvailable: true })).toBe('merge');
  });

  it('honors priority order: rebase (90) beats retry (50) when both could apply', () => {
    const e = engine();
    // stale + red + retry available → both rebase-stale and retry-on-red match; rebase wins.
    const r = e.evaluateWithEvents({ greenAt: false, staleBranch: true, reviewPassed: false, retryAvailable: true });
    expect(r.action).toBe('rebase');
    expect(r.ruleId).toBe('rebase-stale');
  });

  it('falls through to the always() default', () => {
    const e = engine();
    // green but not reviewed, not stale, no retry context → only default matches.
    expect(e.evaluate({ greenAt: true, staleBranch: false, reviewPassed: false, retryAvailable: false })).toBe('wait');
  });

  it('retries on red when a retry is available, else escalates', () => {
    const e = engine();
    expect(e.evaluate({ greenAt: false, staleBranch: false, reviewPassed: false, retryAvailable: true })).toBe('retry');
    expect(e.evaluate({ greenAt: false, staleBranch: false, reviewPassed: false, retryAvailable: false })).toBe('escalate');
  });

  it('produces an explainable decision + per-rule trace', () => {
    const e = engine();
    const r = e.evaluateWithEvents({ greenAt: true, staleBranch: false, reviewPassed: true, retryAvailable: false });
    expect(r.ruleId).toBe('merge-when-green-and-reviewed');
    expect(r.explanation).toMatch(/merge-when-green-and-reviewed fired \(priority 100\)/);
    expect(r.explanation).toMatch(/GreenAt AND ReviewPassed AND NOT StaleBranch/);
    // Trace contains every rule, in priority order, with matched flags.
    expect(r.events).toHaveLength(5);
    expect(r.events[0]?.ruleId).toBe('merge-when-green-and-reviewed');
    expect(r.events[0]?.matched).toBe(true);
    expect(r.events.find((ev) => ev.ruleId === 'rebase-stale')?.matched).toBe(false);
  });

  it('reports "no rule matched" when nothing fires (no default)', () => {
    const e = new PolicyEngine<LoopFacts, LoopAction>([
      { id: 'only-green', priority: 1, action: 'merge', condition: greenAt },
    ]);
    const r = e.evaluateWithEvents({ greenAt: false, staleBranch: false, reviewPassed: false, retryAvailable: false });
    expect(r.action).toBeNull();
    expect(r.ruleId).toBeNull();
    expect(r.explanation).toBe('no rule matched');
  });

  it('and()/or()/not() describe themselves for explanations', () => {
    expect(and(greenAt, reviewPassed).describe()).toBe('(GreenAt AND ReviewPassed)');
    expect(or(greenAt, staleBranch).describe()).toBe('(GreenAt OR StaleBranch)');
    expect(not(greenAt).describe()).toBe('NOT GreenAt');
    expect(and<LoopFacts>().describe()).toBe('true');
    expect(or<LoopFacts>().describe()).toBe('false');
  });

  it('keeps registration order for equal priorities (stable)', () => {
    const e = new PolicyEngine<LoopFacts, LoopAction>([
      { id: 'first', priority: 10, action: 'merge', condition: always() },
      { id: 'second', priority: 10, action: 'wait', condition: always() },
    ]);
    expect(e.evaluate({ greenAt: false, staleBranch: false, reviewPassed: false, retryAvailable: false })).toBe('merge');
  });
});
