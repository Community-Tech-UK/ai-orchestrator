import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('RecentDirectoriesManager', () => {
  let tempRoot = '';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T00:00:00.000Z'));
    vi.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-directories-manager-'));

    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) => {
          if (name === 'home') {
            return tempRoot;
          }
          if (name === 'userData') {
            return tempRoot;
          }
          return tempRoot;
        }),
        addRecentDocument: vi.fn(),
      },
    }));

    vi.doMock('electron-store', () => ({
      default: class MockElectronStore<T extends Record<string, unknown>> {
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
      },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('electron');
    vi.doUnmock('electron-store');
    vi.resetModules();
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('persists manual project order and does not reshuffle existing entries on access', async () => {
    const alpha = path.join(tempRoot, 'alpha');
    const beta = path.join(tempRoot, 'beta');
    const gamma = path.join(tempRoot, 'gamma');
    fs.mkdirSync(alpha, { recursive: true });
    fs.mkdirSync(beta, { recursive: true });
    fs.mkdirSync(gamma, { recursive: true });

    const { RecentDirectoriesManager } = await import('./recent-directories-manager');
    const manager = new RecentDirectoriesManager(10);

    manager.addDirectory(alpha);
    vi.advanceTimersByTime(1_000);
    manager.addDirectory(beta);
    vi.advanceTimersByTime(1_000);
    manager.addDirectory(gamma);

    expect(
      manager.getDirectories({ sortBy: 'manual' }).map((entry) => entry.displayName)
    ).toEqual(['gamma', 'beta', 'alpha']);

    expect(manager.reorderDirectories([beta, gamma, alpha])).toBe(true);
    expect(
      manager.getDirectories({ sortBy: 'manual' }).map((entry) => entry.displayName)
    ).toEqual(['beta', 'gamma', 'alpha']);

    vi.advanceTimersByTime(1_000);
    manager.addDirectory(gamma);

    expect(
      manager.getDirectories({ sortBy: 'manual' }).map((entry) => entry.displayName)
    ).toEqual(['beta', 'gamma', 'alpha']);
    expect(
      manager.getDirectories({ sortBy: 'lastAccessed' })[0]?.displayName
    ).toBe('gamma');
  });

  it('keeps pinned projects ahead of unpinned ones while respecting manual order within each segment', async () => {
    const alpha = path.join(tempRoot, 'alpha');
    const beta = path.join(tempRoot, 'beta');
    const gamma = path.join(tempRoot, 'gamma');
    const delta = path.join(tempRoot, 'delta');
    fs.mkdirSync(alpha, { recursive: true });
    fs.mkdirSync(beta, { recursive: true });
    fs.mkdirSync(gamma, { recursive: true });
    fs.mkdirSync(delta, { recursive: true });

    const { RecentDirectoriesManager } = await import('./recent-directories-manager');
    const manager = new RecentDirectoriesManager(10);

    manager.addDirectory(alpha);
    vi.advanceTimersByTime(1_000);
    manager.addDirectory(beta);
    vi.advanceTimersByTime(1_000);
    manager.addDirectory(gamma);
    vi.advanceTimersByTime(1_000);
    manager.addDirectory(delta);

    expect(manager.reorderDirectories([gamma, alpha, delta, beta])).toBe(true);
    expect(manager.pinDirectory(alpha, true)).toBe(true);
    expect(manager.pinDirectory(gamma, true)).toBe(true);

    expect(
      manager.getDirectories({ sortBy: 'manual' }).map((entry) => entry.displayName)
    ).toEqual(['gamma', 'alpha', 'delta', 'beta']);
  });
});
