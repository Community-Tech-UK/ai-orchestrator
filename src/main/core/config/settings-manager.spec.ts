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

import { SettingsManager, type SettingsConflict, type SettingsWriteContext } from './settings-manager';
import { DEFAULT_REVIEWER_MODEL_BY_PROVIDER } from '../../../shared/types/settings.types';
import { OPENAI_MODELS } from '../../../shared/types/provider.types';

describe('reviewer model defaults backfill', () => {
  beforeEach(() => {
    for (const key of Object.keys(mocks.store)) delete mocks.store[key];
    mocks.setCalls.length = 0;
    mocks.storeSet.mockClear();
  });

  it('backfills missing reviewer models into an existing install', () => {
    // The shipped state before this change: only cursor was pinned, so every
    // other reviewer ran on the CLI's own default.
    mocks.store['crossModelReviewModelByProvider'] = { cursor: 'composer-2.5' };

    new SettingsManager();

    expect(mocks.store['crossModelReviewModelByProvider']).toEqual(
      DEFAULT_REVIEWER_MODEL_BY_PROVIDER,
    );
    expect(
      (mocks.store['crossModelReviewModelByProvider'] as Record<string, string>)['codex'],
    ).toBe(OPENAI_MODELS.GPT56_TERRA);
  });

  it('never overwrites an explicitly chosen reviewer model', () => {
    mocks.store['crossModelReviewModelByProvider'] = { codex: 'gpt-5.5', cursor: 'composer-2.5' };

    new SettingsManager();

    const persisted = mocks.store['crossModelReviewModelByProvider'] as Record<string, string>;
    expect(persisted['codex']).toBe('gpt-5.5');
    expect(persisted['claude']).toBe(DEFAULT_REVIEWER_MODEL_BY_PROVIDER.claude);
  });

  it('runs exactly once, so a later "auto" choice survives a restart', () => {
    mocks.store['crossModelReviewModelByProvider'] = { cursor: 'composer-2.5' };
    new SettingsManager();

    // User then clears codex back to auto (auto == key absence).
    const afterUserEdit = {
      ...(mocks.store['crossModelReviewModelByProvider'] as Record<string, string>),
    };
    delete afterUserEdit['codex'];
    mocks.store['crossModelReviewModelByProvider'] = afterUserEdit;

    new SettingsManager();

    expect(
      (mocks.store['crossModelReviewModelByProvider'] as Record<string, string>)['codex'],
    ).toBeUndefined();
  });
});

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

describe('SettingsManager field-level dirty writes', () => {
  beforeEach(() => {
    for (const key of Object.keys(mocks.store)) delete mocks.store[key];
    mocks.setCalls.length = 0;
    mocks.storeSet.mockClear();
    mocks.withLockSync.mockClear();
    mocks.withLockSync.mockImplementation(<T>(_lockPath: string, fn: () => T) => fn());
  });

  it('preserves a concurrent external change to an unrelated field', () => {
    mocks.store.fontSize = 14;
    const manager = new SettingsManager();
    const conflicts: SettingsConflict[][] = [];
    manager.on('settings-conflict', (found: SettingsConflict[]) => conflicts.push(found));

    // Another process writes fontSize while we change theme.
    mocks.store.fontSize = 18;
    manager.update({ theme: 'light' });

    expect(mocks.store.theme).toBe('light');
    expect(mocks.store.fontSize).toBe(18);
    expect(conflicts).toEqual([]);
  });

  it('merges concurrent nested-field changes, writing only the dirty subfield', () => {
    mocks.store.defaultModelByProvider = { claude: 'opus' };
    const manager = new SettingsManager();
    const conflicts: SettingsConflict[][] = [];
    const emitted: unknown[] = [];
    manager.on('settings-conflict', (found: SettingsConflict[]) => conflicts.push(found));
    manager.on('setting-changed', (_key: keyof AppSettings, value: unknown) => emitted.push(value));

    // Another process adds a sibling key inside the same nested object.
    mocks.store.defaultModelByProvider = { claude: 'opus', codex: 'gpt-5.5' };
    manager.set('defaultModelByProvider', { claude: 'sonnet' });

    expect(mocks.store.defaultModelByProvider).toEqual({ claude: 'sonnet', codex: 'gpt-5.5' });
    expect(conflicts).toEqual([]);
    // The emitted value reflects what was actually persisted (merged).
    expect(emitted).toEqual([{ claude: 'sonnet', codex: 'gpt-5.5' }]);
  });

  it('round-trips customModelsByProvider through normal settings writes', () => {
    const manager = new SettingsManager();
    const customModelsByProvider = {
      claude: ['claude-future-opus'],
      codex: ['gpt-future-codex'],
    };

    manager.set('customModelsByProvider', customModelsByProvider);

    expect(manager.get('customModelsByProvider')).toEqual(customModelsByProvider);
  });

  it('migrates a legacy customModelOverride into the active provider custom model list', () => {
    mocks.store.defaultCli = 'gemini';
    mocks.store.customModelOverride = 'gemini-3-pro-preview';

    new SettingsManager();

    expect(mocks.store.customModelsByProvider).toEqual({
      gemini: ['gemini-3-pro-preview'],
    });
    expect(mocks.store.customModelOverride).toBe('');
  });

  it('does not duplicate a legacy customModelOverride already present in customModelsByProvider', () => {
    mocks.store.defaultCli = 'claude';
    mocks.store.customModelOverride = 'claude-future-opus';
    mocks.store.customModelsByProvider = { claude: ['claude-future-opus'] };

    new SettingsManager();

    expect(mocks.store.customModelsByProvider).toEqual({
      claude: ['claude-future-opus'],
    });
    expect(mocks.store.customModelOverride).toBe('');
  });

  it('does not migrate legacy customModelOverride values beyond the dynamic model id limit', () => {
    const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;
    expect(tooLongCatalogModelId).toHaveLength(513);
    mocks.store.defaultCli = 'claude';
    mocks.store.customModelOverride = tooLongCatalogModelId;

    new SettingsManager();

    expect(mocks.store.customModelsByProvider).toBeUndefined();
    expect(mocks.store.customModelOverride).toBe(tooLongCatalogModelId);
  });

  it('treats nested keys removed by the caller as deletions', () => {
    mocks.store.defaultModelByProvider = { claude: 'opus', codex: 'gpt-5.5' };
    const manager = new SettingsManager();

    manager.set('defaultModelByProvider', { claude: 'opus' });

    expect(mocks.store.defaultModelByProvider).toEqual({ claude: 'opus' });
  });

  it('detects a concurrent write to the same field and keeps last-write-wins', () => {
    mocks.store.theme = 'dark';
    const manager = new SettingsManager();
    const observed: { conflicts: SettingsConflict[]; context: SettingsWriteContext }[] = [];
    manager.on('settings-conflict', (conflicts: SettingsConflict[], context: SettingsWriteContext) =>
      observed.push({ conflicts, context }));
    const expectedVersion = manager.getVersion();

    // Another process changes theme between our last read and our write.
    mocks.store.theme = 'light';
    manager.set('theme', 'solarized');

    expect(mocks.store.theme).toBe('solarized');
    expect(observed).toHaveLength(1);
    expect(observed[0].conflicts).toEqual([
      { path: 'theme', diskValue: 'light', attemptedValue: 'solarized' },
    ]);
    expect(observed[0].context.dirtyPaths).toEqual(['theme']);
    expect(observed[0].context.expectedVersion).toBe(expectedVersion);
  });

  it('does not report a conflict when both writers landed on the same value', () => {
    mocks.store.theme = 'dark';
    const manager = new SettingsManager();
    const conflicts: SettingsConflict[][] = [];
    manager.on('settings-conflict', (found: SettingsConflict[]) => conflicts.push(found));

    mocks.store.theme = 'light';
    manager.set('theme', 'light');

    expect(mocks.store.theme).toBe('light');
    expect(conflicts).toEqual([]);
  });

  it('bumps the in-memory version counter on each durable write', () => {
    const manager = new SettingsManager();
    const before = manager.getVersion();

    manager.set('theme', 'light');
    manager.update({ fontSize: 16 });

    expect(manager.getVersion()).toBe(before + 2);
  });

  it('does not bump the version when the locked write fails', () => {
    const manager = new SettingsManager();
    const before = manager.getVersion();
    mocks.withLockSync.mockImplementationOnce(() => {
      throw new Error('Lock blocked by PID 123 (settings-write)');
    });

    expect(() => manager.set('theme', 'light')).toThrow(/Lock blocked/);

    expect(manager.getVersion()).toBe(before);
  });
});
