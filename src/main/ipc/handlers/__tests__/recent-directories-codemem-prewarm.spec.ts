/**
 * Integration coverage for the "workspace enters the app" trigger.
 *
 * The plan requires opening a directory through the recent-directories IPC path
 * to start codemem prewarm without spawning an instance. This test wires the
 * real RecentDirectoriesManager singleton, the real IPC handler, and a
 * CodememPrewarmCoordinator with a fake codemem target so we can observe the
 * LSP state move off idle without starting sqlite or worker threads.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';
import type {
  PrewarmCodememTarget,
  PrewarmSettingsTarget,
} from '../../../codemem/codemem-prewarm-coordinator';
import type { AppSettings } from '../../../../shared/types/settings.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
type FakeLspState = 'idle' | 'warming' | 'ready' | 'lsp_unavailable';

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

function createPrewarmSettings(): PrewarmSettingsTarget {
  const values: Partial<AppSettings> = {
    codememPrewarmEnabled: true,
    codememPrewarmMaxConcurrent: 1,
    codememPrewarmDebounceMs: 0,
    codememPrewarmStartupHint: true,
  };

  return {
    get<K extends keyof AppSettings>(key: K): AppSettings[K] {
      return values[key] as AppSettings[K];
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

describe('recent directories IPC codemem prewarm integration', () => {
  let tempRoot = '';

  beforeEach(() => {
    vi.resetModules();
    handlers.clear();
    tempRoot = mkdtempSync(path.join(tmpdir(), 'recent-codemem-prewarm-'));

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

    vi.doMock('../../core/config/settings-manager', () => ({
      getSettingsManager: () => ({
        get: (key: keyof AppSettings) => {
          if (key === 'maxRecentDirectories') return 50;
          if (key === 'defaultWorkingDirectory') return '';
          return undefined;
        },
        on: vi.fn(),
      }),
    }));
  });

  afterEach(() => {
    vi.doUnmock('electron');
    vi.doUnmock('electron-store');
    vi.doUnmock('../../core/config/settings-manager');
    vi.resetModules();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('starts codemem prewarm when a local directory is added through RECENT_DIRS_ADD', async () => {
    const workspacePath = path.join(tempRoot, 'workspace');
    mkdirSync(workspacePath, { recursive: true });

    let lspState: FakeLspState = 'idle';
    const codemem: PrewarmCodememTarget = {
      isEnabled: vi.fn(() => true),
      isIndexingEnabled: vi.fn(() => true),
      getLastIndexedAt: vi.fn(() => null),
      warmWorkspace: vi.fn(async () => {
        lspState = 'warming';
        return { ready: false, filePath: null };
      }),
    };

    const { getRecentDirectoriesManager } = await import(
      '../../../core/config/recent-directories-manager'
    );
    const { CodememPrewarmCoordinator } = await import(
      '../../../codemem/codemem-prewarm-coordinator'
    );
    const { registerRecentDirectoriesHandlers } = await import(
      '../recent-directories-handlers'
    );
    const { IPC_CHANNELS } = await import('../../../../shared/types/ipc.types');

    const coordinator = new CodememPrewarmCoordinator({
      recentDirectoriesManager: getRecentDirectoriesManager(),
      codemem,
      settings: createPrewarmSettings(),
    });
    coordinator.start();
    registerRecentDirectoriesHandlers();

    const handler = handlers.get(IPC_CHANNELS.RECENT_DIRS_ADD);
    expect(handler).toBeDefined();
    expect(lspState).toBe('idle');

    const response = await handler!({}, { path: workspacePath });
    await flushMicrotasks();

    expect(response.success).toBe(true);
    expect(codemem.warmWorkspace).toHaveBeenCalledWith(workspacePath, expect.any(Number));
    expect(lspState).toBe('warming');

    coordinator.stop();
  });
});
