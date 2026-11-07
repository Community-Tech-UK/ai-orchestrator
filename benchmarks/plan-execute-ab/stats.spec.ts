import { describe, expect, it } from 'vitest';
import { newcombeDifferenceInterval, wilsonInterval } from './stats';

describe('wilsonInterval', () => {
  it('matches the textbook Wilson interval at 3 of 10', () => {
    const ci = wilsonInterval(3, 10);
    expect(ci.low).toBeCloseTo(0.10779, 4);
    expect(ci.high).toBeCloseTo(0.60322, 4);
  });

  it('does not collapse at 0% or 100%', () => {
    const none = wilsonInterval(0, 10);
    expect(none.low).toBe(0);
    expect(none.high).toBeGreaterThan(0.2);
    expect(none.high).toBeLessThan(0.3);
    const all = wilsonInterval(10, 10);
    expect(all.high).toBe(1);
    expect(all.low).toBeGreaterThan(0.7);
    expect(all.low).toBeLessThan(0.8);
  });

  it('narrows as the task count grows (the unit the report passes is tasks)', () => {
    const oneTask = wilsonInterval(1, 1);
    const thirtyTasks = wilsonInterval(30, 30);
    expect(oneTask.high - oneTask.low).toBeGreaterThan(thirtyTasks.high - thirtyTasks.low);
    expect(thirtyTasks.low).toBeGreaterThan(0.85);
  });

  it('accepts fractional successes (per-task solve fractions) and stays bounded', () => {
    const ci = wilsonInterval(2.5, 5);
    expect(ci.low).toBeCloseTo(0.17042, 4);
    expect(ci.high).toBeCloseTo(0.82958, 4);
    const clamped = wilsonInterval(-3, 5);
    expect(clamped.low).toBe(0);
  });

  it('returns an uninformative range when there are no trials', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe('newcombeDifferenceInterval', () => {
  it('spans zero when the arms are the same', () => {
    const ci = wilsonInterval(5, 10);
    const gap = newcombeDifferenceInterval(0.5, ci, 0.5, ci);
    expect(gap.low).toBeLessThan(0);
    expect(gap.high).toBeGreaterThan(0);
  });

  it('excludes zero when 10/10 beats 0/10', () => {
    const winner = wilsonInterval(10, 10);
    const loser = wilsonInterval(0, 10);
    const gap = newcombeDifferenceInterval(1, winner, 0, loser);
    expect(gap.low).toBeGreaterThan(0.5);
    expect(gap.high).toBeLessThanOrEqual(1);
  });

  it('is directional (p1 − p2 flips sign with the arguments)', () => {
    const winner = wilsonInterval(10, 10);
    const loser = wilsonInterval(0, 10);
    const forward = newcombeDifferenceInterval(1, winner, 0, loser);
    const backward = newcombeDifferenceInterval(0, loser, 1, winner);
    expect(backward.low).toBeCloseTo(-forward.high, 10);
    expect(backward.high).toBeCloseTo(-forward.low, 10);
  });
});
