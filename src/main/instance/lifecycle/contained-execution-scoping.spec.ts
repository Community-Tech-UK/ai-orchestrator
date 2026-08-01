import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetContainedExecutionScopingForTesting,
  isInstanceContainedExecution,
  removeInstanceContainedExecution,
  setInstanceContainedExecution,
} from './contained-execution-scoping';

describe('contained-execution-scoping registry', () => {
  beforeEach(() => _resetContainedExecutionScopingForTesting());

  it('defaults to not contained, including for undefined ids', () => {
    expect(isInstanceContainedExecution('inst-1')).toBe(false);
    expect(isInstanceContainedExecution(undefined)).toBe(false);
  });

  it('records and clears the contained flag per instance', () => {
    setInstanceContainedExecution('inst-1', true);
    expect(isInstanceContainedExecution('inst-1')).toBe(true);
    expect(isInstanceContainedExecution('inst-2')).toBe(false);

    removeInstanceContainedExecution('inst-1');
    expect(isInstanceContainedExecution('inst-1')).toBe(false);
  });

  it('treats false/undefined writes as deletion (create with contained off)', () => {
    setInstanceContainedExecution('inst-1', true);
    setInstanceContainedExecution('inst-1', false);
    expect(isInstanceContainedExecution('inst-1')).toBe(false);

    setInstanceContainedExecution('inst-2', undefined);
    expect(isInstanceContainedExecution('inst-2')).toBe(false);
  });

  it('evicts the oldest entry beyond the bound instead of growing unbounded', () => {
    for (let i = 0; i < 1001; i++) {
      setInstanceContainedExecution(`inst-${i}`, true);
    }
    expect(isInstanceContainedExecution('inst-0')).toBe(false);
    expect(isInstanceContainedExecution('inst-1000')).toBe(true);
  });
});
