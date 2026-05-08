/**
 * Regression tests for the RTK IPC handlers. Verifies that:
 *
 * - `RTK_GET_STATUS` sources its fields from the RTK runtime + tracking reader
 *   + settings manager (no live SQLite or filesystem access required).
 * - `RTK_GET_SUMMARY` and `RTK_GET_HISTORY` validate their payloads via the
 *   shared `validatedHandler` and forward typed payloads to the reader.
 * - The runtime singleton is correctly rebuilt when `bundledOnly` toggles.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../validated-handler';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
}));

const runtimeMocks = vi.hoisted(() => ({
  isAvailable: vi.fn(() => true),
  binarySource: vi.fn(() => 'bundled' as const),
  version: vi.fn(() => '0.39.0' as string | null),
  // The runtime factory itself; we capture the args for the version assertion
  // below so we can confirm `bundledOnly` is honoured.
  factory: vi.fn(),
}));

const readerMocks = vi.hoisted(() => ({
  getDbPath: vi.fn(() => '/tmp/tracking.db'),
  isAvailable: vi.fn(() => true),
  getSummary: vi.fn(),
  getRecentHistory: vi.fn(),
}));

const settingsMocks = vi.hoisted(() => ({
  values: new Map<string, unknown>([
    ['rtkEnabled', true],
    ['rtkBundledOnly', false],
  ]),
}));

vi.mock('../../../cli/rtk/rtk-runtime', () => ({
  getRtkRuntime: (opts?: { bundledOnly?: boolean }) => {
    runtimeMocks.factory(opts ?? {});
    return {
      isAvailable: runtimeMocks.isAvailable,
      binarySource: runtimeMocks.binarySource,
      version: runtimeMocks.version,
    };
  },
}));

vi.mock('../../../cli/rtk/rtk-tracking-reader', () => ({
  // RtkTrackingReader is imported as a type-only re-export; provide a stub
  // class so the runtime import does not blow up.
  RtkTrackingReader: class {},
  getRtkTrackingReader: () => ({
    getDbPath: readerMocks.getDbPath,
    isAvailable: readerMocks.isAvailable,
    getSummary: readerMocks.getSummary,
    getRecentHistory: readerMocks.getRecentHistory,
  }),
}));

vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: (key: string) => settingsMocks.values.get(key),
  }),
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { registerRtkHandlers } from '../rtk-handlers';

const fakeEvent = {};

describe('rtk-handlers', () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
    runtimeMocks.factory.mockReset();
    runtimeMocks.isAvailable.mockReset().mockReturnValue(true);
    runtimeMocks.binarySource.mockReset().mockReturnValue('bundled');
    runtimeMocks.version.mockReset().mockReturnValue('0.39.0');
    readerMocks.getDbPath.mockReset().mockReturnValue('/tmp/tracking.db');
    readerMocks.isAvailable.mockReset().mockReturnValue(true);
    readerMocks.getSummary.mockReset();
    readerMocks.getRecentHistory.mockReset();
    settingsMocks.values.set('rtkEnabled', true);
    settingsMocks.values.set('rtkBundledOnly', false);
    registerRtkHandlers();
  });

  it('reports runtime status, settings, and reader availability', async () => {
    const result = await invoke('rtk:get-status');

    expect(result).toMatchObject({
      success: true,
      data: {
        enabled: true,
        available: true,
        binarySource: 'bundled',
        version: '0.39.0',
        trackingDbPath: '/tmp/tracking.db',
        trackingDbAvailable: true,
      },
    });
    // Settings → runtime should pass `bundledOnly` through.
    expect(runtimeMocks.factory).toHaveBeenCalledWith({ bundledOnly: false });
  });

  it('honours rtkBundledOnly when computing status', async () => {
    settingsMocks.values.set('rtkBundledOnly', true);

    await invoke('rtk:get-status');

    expect(runtimeMocks.factory).toHaveBeenCalledWith({ bundledOnly: true });
  });

  it('reports unavailable when the runtime cannot locate a binary', async () => {
    runtimeMocks.isAvailable.mockReturnValue(false);
    runtimeMocks.binarySource.mockReturnValue('none');
    runtimeMocks.version.mockReturnValue(null);
    readerMocks.isAvailable.mockReturnValue(false);

    const result = await invoke('rtk:get-status');

    expect(result).toMatchObject({
      success: true,
      data: {
        enabled: true,
        available: false,
        binarySource: 'none',
        version: null,
        trackingDbAvailable: false,
      },
    });
  });

  it('returns a summary from the tracking reader for a valid payload', async () => {
    readerMocks.getSummary.mockReturnValue({
      commands: 12,
      totalInput: 1000,
      totalOutput: 200,
      totalSaved: 800,
      avgSavingsPct: 80,
      byCommand: [],
      lastCommandAt: '2026-05-08T00:00:00.000Z',
    });

    const result = await invoke('rtk:get-summary', {
      projectPath: '/home/user/repo',
      sinceMs: 1700000000000,
      topN: 5,
    });

    expect(result).toMatchObject({
      success: true,
      data: { commands: 12, totalSaved: 800 },
    });
    expect(readerMocks.getSummary).toHaveBeenCalledWith({
      projectPath: '/home/user/repo',
      sinceMs: 1700000000000,
      topN: 5,
    });
  });

  it('rejects summary payloads that violate the validation schema', async () => {
    const result = await invoke('rtk:get-summary', { topN: 9999 });

    expect(result.success).toBe(false);
    expect(readerMocks.getSummary).not.toHaveBeenCalled();
  });

  it('accepts an empty summary payload (defaults applied)', async () => {
    readerMocks.getSummary.mockReturnValue({
      commands: 0,
      totalInput: 0,
      totalOutput: 0,
      totalSaved: 0,
      avgSavingsPct: 0,
      byCommand: [],
      lastCommandAt: null,
    });

    const result = await invoke('rtk:get-summary');

    expect(result.success).toBe(true);
    expect(readerMocks.getSummary).toHaveBeenCalledWith({
      projectPath: undefined,
      sinceMs: undefined,
      topN: undefined,
    });
  });

  it('returns recent history from the reader for a valid payload', async () => {
    readerMocks.getRecentHistory.mockReturnValue([
      {
        timestamp: '2026-05-08T00:00:00.000Z',
        originalCmd: 'git status',
        rtkCmd: 'rtk git status',
        savedTokens: 100,
        savingsPct: 50,
        projectPath: '/home/user/repo',
      },
    ]);

    const result = await invoke('rtk:get-history', {
      projectPath: '/home/user/repo',
      limit: 25,
    });

    expect(result).toMatchObject({
      success: true,
      data: [{ originalCmd: 'git status' }],
    });
    expect(readerMocks.getRecentHistory).toHaveBeenCalledWith({
      projectPath: '/home/user/repo',
      limit: 25,
    });
  });

  it('rejects history payloads that violate the validation schema', async () => {
    const result = await invoke('rtk:get-history', { limit: 99999 });

    expect(result.success).toBe(false);
    expect(readerMocks.getRecentHistory).not.toHaveBeenCalled();
  });
});

function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler(fakeEvent, payload);
}
