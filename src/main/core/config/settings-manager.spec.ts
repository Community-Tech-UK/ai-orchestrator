import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../shared/types/settings.types';

const mocks = vi.hoisted(() => {
  const store: Record<string, unknown> = {};
  const setCalls: unknown[][] = [];
  return {
    store,
    setCalls,
    withLockSync: vi.fn(<T>(_lockPath: string, fn: () => T) => fn()),
    storeSet: vi.fn((keyOrObject: string | Record<string, unknown>, value?: unknown) => {
      setCalls.push(
        typeof keyOrObject === 'object'
          ? [structuredClone(keyOrObject)]
          : [keyOrObject, value],
      );
      if (typeof keyOrObject === 'object') {
        Object.assign(store, keyOrObject);
      } else {
        store[keyOrObject] = value;
      }
    }),
  };
});

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    get store() { return { ...mocks.store }; },
    get: vi.fn((key: string) => mocks.store[key]),
    set: mocks.storeSet,
    clear: vi.fn(() => {
      for (const key of Object.keys(mocks.store)) delete mocks.store[key];
    }),
    path: '/tmp/aio-test-settings.json',
  })),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => `/tmp/aio-test-${key}`),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../util/file-lock', () => ({
  withLockSync: mocks.withLockSync,
}));

import { SettingsManager } from './settings-manager';

describe('SettingsManager locked writes', () => {
  beforeEach(() => {
    for (const key of Object.keys(mocks.store)) delete mocks.store[key];
    mocks.setCalls.length = 0;
    mocks.storeSet.mockClear();
    mocks.withLockSync.mockClear();
    mocks.withLockSync.mockImplementation(<T>(_lockPath: string, fn: () => T) => fn());
  });

  it('serializes single setting writes through the settings file lock', () => {
    const manager = new SettingsManager();
    mocks.withLockSync.mockClear();
    mocks.setCalls.length = 0;

    manager.set('theme', 'light');

    expect(mocks.withLockSync).toHaveBeenCalledOnce();
    expect(mocks.withLockSync).toHaveBeenCalledWith(
      '/tmp/aio-test-settings.json.lock',
      expect.any(Function),
      expect.objectContaining({ purpose: 'settings-write' }),
    );
    expect(mocks.store.theme).toBe('light');
    expect(mocks.setCalls).toEqual([['theme', 'light']]);
  });

  it('persists bulk dirty fields once under one lock before emitting events', () => {
    const manager = new SettingsManager();
    const observed: string[] = [];
    manager.on('setting-changed', (key: keyof AppSettings) => observed.push(`event:${String(key)}`));
    mocks.withLockSync.mockClear();
    mocks.setCalls.length = 0;
    mocks.storeSet.mockImplementationOnce((keyOrObject: string | Record<string, unknown>, value?: unknown) => {
      observed.push('persist');
      if (typeof keyOrObject === 'object') {
        mocks.setCalls.push([structuredClone(keyOrObject)]);
        Object.assign(mocks.store, keyOrObject);
      } else {
        mocks.setCalls.push([keyOrObject, value]);
        mocks.store[keyOrObject] = value;
      }
    });

    manager.update({ theme: 'light', fontSize: 16 });

    expect(mocks.withLockSync).toHaveBeenCalledOnce();
    expect(mocks.setCalls).toEqual([[{ theme: 'light', fontSize: 16 }]]);
    expect(observed).toEqual(['persist', 'event:theme', 'event:fontSize']);
  });

  it('does not emit setting events when the write lock cannot be acquired', () => {
    const manager = new SettingsManager();
    const observed: string[] = [];
    manager.on('setting-changed', (key: keyof AppSettings) => observed.push(String(key)));
    mocks.withLockSync.mockClear();
    mocks.withLockSync.mockImplementationOnce(() => {
      throw new Error('Lock blocked by PID 123 (settings-write)');
    });

    expect(() => manager.set('theme', 'light')).toThrow(/Lock blocked/);

    expect(mocks.store.theme).not.toBe('light');
    expect(observed).toEqual([]);
  });
});
