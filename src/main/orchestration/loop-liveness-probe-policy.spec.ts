import { describe, expect, it } from 'vitest';
import {
  evaluateLivenessPass,
  MASS_DEAD_FRACTION,
  MASS_DEAD_MIN_SESSIONS,
  type LivenessProbeResult,
} from './loop-liveness-probe-policy';

function pass(verdicts: readonly LivenessProbeResult['verdict'][]): LivenessProbeResult[] {
  return verdicts.map((verdict, index) => ({ sessionId: `s${index}`, verdict }));
}

describe('evaluateLivenessPass (L9)', () => {
  it('acts on a single dead session in a healthy pass', () => {
    const outcome = evaluateLivenessPass(pass(['alive', 'alive', 'dead', 'alive']));

    expect(outcome.actionable).toBe(true);
    expect(outcome.actionable_dead).toEqual(['s2']);
    expect(outcome.deadCount).toBe(1);
  });

  // The whole point: a probe outage reports everything dead at once, and acting
  // on it reaps healthy work.
  it('rewrites a mass-dead pass as inconclusive and acts on nothing', () => {
    const outcome = evaluateLivenessPass(pass(Array<LivenessProbeResult['verdict']>(8).fill('dead')));

    expect(outcome.actionable).toBe(false);
    expect(outcome.actionable_dead).toEqual([]);
    expect(outcome.deadCount).toBe(8);
    expect(outcome.reason).toContain('inconclusive');
  });

  // Both halves of the shape test are load-bearing. Fraction alone would veto a
  // legitimate "both of the two sessions I was watching finished".
  it('still acts when the fraction is high but the count is small', () => {
    const outcome = evaluateLivenessPass(pass(['dead', 'dead']));

    expect(outcome.deadCount).toBeLessThan(MASS_DEAD_MIN_SESSIONS);
    expect(outcome.actionable).toBe(true);
    expect(outcome.actionable_dead).toEqual(['s0', 's1']);
  });

  // Count alone would let a real 5-of-500 cull look like an outage.
  it('still acts when the count is high but it is a small share of the pass', () => {
    const verdicts: LivenessProbeResult['verdict'][] = [
      ...Array<LivenessProbeResult['verdict']>(6).fill('dead'),
      ...Array<LivenessProbeResult['verdict']>(40).fill('alive'),
    ];
    const outcome = evaluateLivenessPass(pass(verdicts));

    expect(outcome.deadCount).toBeGreaterThanOrEqual(MASS_DEAD_MIN_SESSIONS);
    expect(outcome.deadCount / outcome.total).toBeLessThan(MASS_DEAD_FRACTION);
    expect(outcome.actionable).toBe(true);
  });

  // A probe that could not answer is not evidence of death.
  it('never counts an unknown verdict as dead', () => {
    const outcome = evaluateLivenessPass(pass(['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']));

    expect(outcome.deadCount).toBe(0);
    expect(outcome.actionable).toBe(false);
    expect(outcome.actionable_dead).toEqual([]);
  });

  it('counts unknowns toward the pass total, so they cannot manufacture an outage verdict', () => {
    const verdicts: LivenessProbeResult['verdict'][] = [
      ...Array<LivenessProbeResult['verdict']>(5).fill('dead'),
      ...Array<LivenessProbeResult['verdict']>(20).fill('unknown'),
    ];
    const outcome = evaluateLivenessPass(pass(verdicts));

    expect(outcome.total).toBe(25);
    expect(outcome.actionable).toBe(true);
  });

  it('treats an empty pass as no information, not as all-alive', () => {
    const outcome = evaluateLivenessPass([]);

    expect(outcome.actionable).toBe(false);
    expect(outcome.reason).toContain('empty');
  });

  it('honours caller-supplied thresholds', () => {
    const outcome = evaluateLivenessPass(pass(['dead', 'dead', 'alive']), { minSessions: 2, fraction: 0.5 });

    expect(outcome.actionable).toBe(false);
  });
});
