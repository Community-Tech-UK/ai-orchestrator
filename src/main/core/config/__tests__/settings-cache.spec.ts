import { describe, it, expect, vi, beforeEach } from 'vitest';

// ElectronStore mock — in-memory key/value
const store: Record<string, unknown> = {};
vi.mock('electron-store', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      get store() { return { ...store }; },
      get: vi.fn((k: string) => store[k]),
      set: vi.fn((k: string | Record<string, unknown>, v?: unknown) => {
        if (typeof k === 'object') Object.assign(store, k);
        else store[k] = v;
      }),
      clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k]; }),
      path: '/tmp/test-settings.json',
    })),
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => `/tmp/test-${key}`),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  watch: vi.fn(() => ({ close: vi.fn() })),
}));

import { SettingsManager } from '../settings-manager';

beforeEach(() => {
  // Clear store between tests
  for (const k of Object.keys(store)) delete store[k];
});

describe('SettingsManager settings cache', () => {
  it('getMerged() returns a settings object', () => {
    const mgr = new SettingsManager();
    const merged = mgr.getMerged();
    expect(merged).toBeDefined();
    expect(typeof merged).toBe('object');
  });

  it('getMerged() returns the same reference on repeated calls (cached)', () => {
    const mgr = new SettingsManager();
    const first = mgr.getMerged();
    const second = mgr.getMerged();
    // Same object reference — cache is alive
    expect(first).toBe(second);
  });

  it('invalidate(3) clears the merged cache', () => {
    const mgr = new SettingsManager();
    const first = mgr.getMerged();
    mgr.invalidate(3);
    const second = mgr.getMerged();
    // New object after invalidation
    expect(first).not.toBe(second);
  });

  it('invalidate(1) cascades to levels 2 and 3', () => {
    const mgr = new SettingsManager();
    const first = mgr.getMerged();
    mgr.invalidate(1);
    const second = mgr.getMerged();
    expect(first).not.toBe(second);
  });

  it('invalidate() with no argument clears all levels', () => {
    const mgr = new SettingsManager();
    const first = mgr.getMerged();
    mgr.invalidate();
    const second = mgr.getMerged();
    expect(first).not.toBe(second);
  });

  it('getMerged() reflects a setting change after invalidation', () => {
    const mgr = new SettingsManager();
    mgr.set('theme', 'dark' as any);
    mgr.invalidate(3);
    const merged = mgr.getMerged();
    expect((merged as any).theme).toBe('dark');
  });

  it('migrates persisted GPT-5.4 defaults to GPT-5.5', () => {
    store['defaultModel'] = 'gpt-5.4-mini';
    const mgr = new SettingsManager();

    expect(mgr.get('defaultModel')).toBe('gpt-5.5-mini');
  });
});
