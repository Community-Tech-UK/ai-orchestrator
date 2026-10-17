import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetSignalFenceScopingForTesting,
  isInstanceSignalFenceDisabled,
  removeInstanceSignalFence,
  setInstanceSignalFence,
} from './signal-fence-scoping';

describe('signal-fence-scoping registry', () => {
  beforeEach(() => _resetSignalFenceScopingForTesting());

  it('keeps the fence on by default, including for undefined ids', () => {
    expect(isInstanceSignalFenceDisabled('inst-1')).toBe(false);
    expect(isInstanceSignalFenceDisabled(undefined)).toBe(false);
  });

  it('turns the fence off only for an explicit false', () => {
    setInstanceSignalFence('inst-1', false);
    setInstanceSignalFence('inst-2', true);
    setInstanceSignalFence('inst-3', undefined);
    expect(isInstanceSignalFenceDisabled('inst-1')).toBe(true);
    expect(isInstanceSignalFenceDisabled('inst-2')).toBe(false);
    expect(isInstanceSignalFenceDisabled('inst-3')).toBe(false);
  });

  it('turns the fence back on when rewritten or removed', () => {
    setInstanceSignalFence('inst-1', false);
    setInstanceSignalFence('inst-1', undefined);
    expect(isInstanceSignalFenceDisabled('inst-1')).toBe(false);

    setInstanceSignalFence('inst-2', false);
    removeInstanceSignalFence('inst-2');
    expect(isInstanceSignalFenceDisabled('inst-2')).toBe(false);
  });

  it('evicts the oldest override beyond the bound, which re-fences it', () => {
    for (let i = 0; i < 1001; i++) {
      setInstanceSignalFence(`inst-${i}`, false);
    }
    expect(isInstanceSignalFenceDisabled('inst-0')).toBe(false);
    expect(isInstanceSignalFenceDisabled('inst-1000')).toBe(true);
  });
});
