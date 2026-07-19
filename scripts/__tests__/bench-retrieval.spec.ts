import { describe, expect, it } from 'vitest';
import { planBenchActions } from '../bench-retrieval';

describe('planBenchActions (bench-retrieval.ts CLI action planning)', () => {
  it('runs regression-check + local suite by default', () => {
    expect(planBenchActions(new Set())).toEqual({
      updateBaseline: false,
      checkRegression: true,
      runLocal: false,
    });
  });

  it('runs the local suite only when --local is passed', () => {
    expect(planBenchActions(new Set(['--local']))).toEqual({
      updateBaseline: false,
      checkRegression: true,
      runLocal: true,
    });
  });

  it('--update-baseline touches only the committed synthetic suite/baseline, never the local suite', () => {
    expect(planBenchActions(new Set(['--update-baseline']))).toEqual({
      updateBaseline: true,
      checkRegression: false,
      runLocal: false,
    });
  });

  it('--update-baseline combined with --local STILL never runs the local suite (regression guard for LT-005)', () => {
    const actions = planBenchActions(new Set(['--update-baseline', '--local']));
    expect(actions.updateBaseline).toBe(true);
    expect(actions.runLocal).toBe(false);
  });
});
