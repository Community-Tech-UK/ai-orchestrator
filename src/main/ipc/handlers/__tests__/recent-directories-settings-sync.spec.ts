/**
 * Regression coverage for runtime propagation of the `maxRecentDirectories`
 * setting into the RecentDirectoriesManager.
 *
 * The handler subscribes to SettingsManager change events so that editing the
 * limit in the settings UI takes effect immediately (not just on restart).
 * SettingsManager emits `setting-changed` with `(key, value)` — it never emits
 * a plain `change` event. A prior bug subscribed to `change`, so the listener
 * never fired and runtime edits silently no-op'd until the next launch. These
 * tests use a real EventEmitter-backed settings mock so the event *name* is
 * load-bearing, and the real RecentDirectoriesManager so the wiring is real.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';
import type { AppSettings } from '../../../../shared/types/settings.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const handlers = new Map<string, IpcHandler>();

function createStoreMock(tempRoot: string) {
  return class MockElectronStore<T extends Record<string, unknown>> {
    private data: Record<string, unknown>;
    path = path.join(tempRoot, 'recent-directories.json');

    constructor(options?: { defaults?: T }) {
      this.data = structuredClone(options?.defaults ?? {});
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.data[key as string] as T[K];
    }

    set<K extends keyof T>(key: K, value: T[K]): void;
    set(object: Partial<T>): void;
    set(keyOrObject: keyof T | Partial<T>, value?: T[keyof T]): void {
      if (typeof keyOrObject === 'string') {
        this.data[keyOrObject] = value;
        return;
      }
      Object.assign(this.data, keyOrObject);
    }

    clear(): void {
      this.data = {};
    }

    get store(): T {
      return this.data as T;
    }
  };
}

/** A SettingsManager stand-in whose event surface mirrors the real one. */
class FakeSettings extends EventEmitter {
  private readonly values: Partial<AppSettings>;

  constructor(values: Partial<AppSettings>) {
    super();
    this.values = values;
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.values[key] as AppSettings[K];
  }

  /** Mirror SettingsManager.set: persist + emit the real event shape. */
  setValue<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.values[key] = value;
    this.emit('setting-changed', key, value);
    this.emit(`setting:${String(key)}`, value);
  }
}

let settings: FakeSettings;
let tempRoot = '';

describe('recent directories settings sync', () => {
  beforeEach(() => {
    vi.resetModules();
    handlers.clear();
    tempRoot = mkdtempSync(path.join(tmpdir(), 'recent-dirs-settings-sync-'));

    settings = new FakeSettings({ maxRecentDirectories: 200, defaultWorkingDirectory: '' });

    vi.doMock('electron', () => ({
      ipcMain: {
        handle: vi.fn((channel: string, handler: IpcHandler) => {
          handlers.set(channel, handler);
        }),
      },
      app: {
        getPath: vi.fn(() => tempRoot),
        addRecentDocument: vi.fn(),
      },
    }));

    vi.doMock('electron-store', () => ({
      default: createStoreMock(tempRoot),
    }));

    vi.doMock('../../../core/config/settings-manager', () => ({
      getSettingsManager: () => settings,
    }));
  });

  afterEach(() => {
    vi.doUnmock('electron');
    vi.doUnmock('electron-store');
    vi.doUnmock('../../../core/config/settings-manager');
    vi.resetModules();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('applies the initial maxRecentDirectories on registration', async () => {
    const { getRecentDirectoriesManager } = await import('../../../core/config/recent-directories-manager');
    const { registerRecentDirectoriesHandlers } = await import('../recent-directories-handlers');
    const manager = getRecentDirectoriesManager();
    const spy = vi.spyOn(manager, 'setMaxEntries');

    registerRecentDirectoriesHandlers();

    expect(spy).toHaveBeenCalledWith(200);
  });

  it('propagates a runtime maxRecentDirectories change via setting-changed', async () => {
    const { getRecentDirectoriesManager } = await import('../../../core/config/recent-directories-manager');
    const { registerRecentDirectoriesHandlers } = await import('../recent-directories-handlers');
    const manager = getRecentDirectoriesManager();
    const spy = vi.spyOn(manager, 'setMaxEntries');
    registerRecentDirectoriesHandlers();
    spy.mockClear(); // drop the initial apply-on-registration call

    settings.setValue('maxRecentDirectories', 25);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(25);
  });

  it('ignores unrelated setting changes', async () => {
    const { getRecentDirectoriesManager } = await import('../../../core/config/recent-directories-manager');
    const { registerRecentDirectoriesHandlers } = await import('../recent-directories-handlers');
    const manager = getRecentDirectoriesManager();
    const spy = vi.spyOn(manager, 'setMaxEntries');
    registerRecentDirectoriesHandlers();
    spy.mockClear();

    settings.setValue('defaultWorkingDirectory', '/somewhere/else');

    expect(spy).not.toHaveBeenCalled();
  });

  it('does not react to a legacy `change` event (regression guard for the wrong event name)', async () => {
    const { getRecentDirectoriesManager } = await import('../../../core/config/recent-directories-manager');
    const { registerRecentDirectoriesHandlers } = await import('../recent-directories-handlers');
    const manager = getRecentDirectoriesManager();
    const spy = vi.spyOn(manager, 'setMaxEntries');
    registerRecentDirectoriesHandlers();
    spy.mockClear();

    // The old (buggy) subscription listened for this name; nothing should react.
    settings.emit('change', 'maxRecentDirectories', 25);

    expect(spy).not.toHaveBeenCalled();
  });
});
