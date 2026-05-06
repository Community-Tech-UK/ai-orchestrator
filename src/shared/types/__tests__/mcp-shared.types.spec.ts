import { describe, expect, it } from 'vitest';
import { DRIFT_STATES, type DriftState } from '../mcp-shared.types';

describe('mcp-shared.types', () => {
  it('exposes drift states', () => {
    expect(DRIFT_STATES).toEqual(['in-sync', 'drifted', 'missing', 'not-installed']);
  });

  it('supports discriminated drift state assignment', () => {
    const state: DriftState = 'in-sync';
    expect(DRIFT_STATES.includes(state)).toBe(true);
  });
});
