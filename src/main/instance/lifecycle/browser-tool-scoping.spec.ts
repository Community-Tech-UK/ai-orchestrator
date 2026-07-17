import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetBrowserToolScopingForTesting,
  getInstanceBrowserToolsMode,
  removeInstanceBrowserToolsMode,
  resolveBrowserToolsMode,
  setInstanceBrowserToolsMode,
} from './browser-tool-scoping';

describe('browser-tool-scoping', () => {
  beforeEach(() => {
    _resetBrowserToolScopingForTesting();
  });

  it('stores, reads, and removes per-instance modes', () => {
    setInstanceBrowserToolsMode('i1', 'off');
    expect(getInstanceBrowserToolsMode('i1')).toBe('off');

    removeInstanceBrowserToolsMode('i1');
    expect(getInstanceBrowserToolsMode('i1')).toBeUndefined();
  });

  it('clears an entry when set to undefined (global default again)', () => {
    setInstanceBrowserToolsMode('i1', 'eager');
    setInstanceBrowserToolsMode('i1', undefined);
    expect(getInstanceBrowserToolsMode('i1')).toBeUndefined();
  });

  it('evicts the oldest entry beyond the bound', () => {
    for (let i = 0; i < 1001; i++) {
      setInstanceBrowserToolsMode(`i${i}`, 'deferred');
    }
    expect(getInstanceBrowserToolsMode('i0')).toBeUndefined();
    expect(getInstanceBrowserToolsMode('i1000')).toBe('deferred');
  });

  it('resolves the per-instance override over the global setting', () => {
    expect(resolveBrowserToolsMode('off', true)).toBe('off');
    expect(resolveBrowserToolsMode('eager', true)).toBe('eager');
    expect(resolveBrowserToolsMode('deferred', false)).toBe('deferred');
  });

  it('falls back to the global deferral setting when no override exists', () => {
    expect(resolveBrowserToolsMode(undefined, true)).toBe('deferred');
    expect(resolveBrowserToolsMode(undefined, false)).toBe('eager');
  });
});
