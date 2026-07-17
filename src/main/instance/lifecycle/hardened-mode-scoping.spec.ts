import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetHardenedModeScopingForTesting,
  addInstanceWritableRoot,
  getInstanceExtraWritableRoots,
  isInstanceHardened,
  removeInstanceHardened,
  setInstanceHardened,
} from './hardened-mode-scoping';

describe('hardened-mode-scoping registry', () => {
  beforeEach(() => _resetHardenedModeScopingForTesting());

  it('defaults to not hardened, including for undefined ids', () => {
    expect(isInstanceHardened('inst-1')).toBe(false);
    expect(isInstanceHardened(undefined)).toBe(false);
  });

  it('records and clears the hardened flag per instance', () => {
    setInstanceHardened('inst-1', true);
    expect(isInstanceHardened('inst-1')).toBe(true);
    expect(isInstanceHardened('inst-2')).toBe(false);

    removeInstanceHardened('inst-1');
    expect(isInstanceHardened('inst-1')).toBe(false);
  });

  it('treats false/undefined writes as deletion (create with hardened off)', () => {
    setInstanceHardened('inst-1', true);
    setInstanceHardened('inst-1', false);
    expect(isInstanceHardened('inst-1')).toBe(false);

    setInstanceHardened('inst-2', undefined);
    expect(isInstanceHardened('inst-2')).toBe(false);
  });

  it('evicts the oldest entry beyond the bound instead of growing unbounded', () => {
    for (let i = 0; i < 1001; i++) {
      setInstanceHardened(`inst-${i}`, true);
    }
    expect(isInstanceHardened('inst-0')).toBe(false);
    expect(isInstanceHardened('inst-1000')).toBe(true);
  });
});

describe('hardened-mode-scoping writable-root grants (allow-and-retry)', () => {
  beforeEach(() => _resetHardenedModeScopingForTesting());

  it('rejects grants for non-hardened instances', () => {
    expect(addInstanceWritableRoot('inst-1', '/tmp/extra')).toBe(false);
    expect(getInstanceExtraWritableRoots('inst-1')).toEqual([]);
  });

  it('records deduplicated grants for hardened instances', () => {
    setInstanceHardened('inst-1', true);
    expect(addInstanceWritableRoot('inst-1', '/tmp/extra')).toBe(true);
    expect(addInstanceWritableRoot('inst-1', '/tmp/extra')).toBe(true);
    expect(addInstanceWritableRoot('inst-1', '/tmp/other')).toBe(true);
    expect(getInstanceExtraWritableRoots('inst-1')).toEqual(['/tmp/extra', '/tmp/other']);
    expect(getInstanceExtraWritableRoots(undefined)).toEqual([]);
  });

  it('keeps grants across a redundant hardened re-set, clears them on removal', () => {
    setInstanceHardened('inst-1', true);
    addInstanceWritableRoot('inst-1', '/tmp/extra');
    setInstanceHardened('inst-1', true); // e.g. restore path re-registers
    expect(getInstanceExtraWritableRoots('inst-1')).toEqual(['/tmp/extra']);

    removeInstanceHardened('inst-1');
    expect(getInstanceExtraWritableRoots('inst-1')).toEqual([]);
    expect(isInstanceHardened('inst-1')).toBe(false);
  });

  it('returns a defensive copy — callers cannot mutate the stored grants', () => {
    setInstanceHardened('inst-1', true);
    addInstanceWritableRoot('inst-1', '/tmp/extra');
    getInstanceExtraWritableRoots('inst-1').push('/tmp/injected');
    expect(getInstanceExtraWritableRoots('inst-1')).toEqual(['/tmp/extra']);
  });
});
