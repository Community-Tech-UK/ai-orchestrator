/**
 * Shared Electron mock harness for main-process Vitest specs.
 *
 * Use with `vi.hoisted` so the harness is created before Vitest hoists `vi.mock`.
 * Load via `require('…/electron-mock.ts')` inside the hoisted factory — a top-level
 * ESM import is still in TDZ when `vi.hoisted` runs:
 *
 *   const electronHarness = vi.hoisted(() => {
 *     const { createElectronHarness } =
 *       require('../testing/electron-mock.ts') as typeof import('../testing/electron-mock');
 *     return createElectronHarness({ ipc: true });
 *   });
 *   vi.mock('electron', () => electronHarness.module);
 */

import { EventEmitter } from 'node:events';
import { vi, type Mock } from 'vitest';

export type IpcHandler = (event: unknown, payload?: unknown) => unknown;

export interface ElectronHarnessOptions {
  /** Default userData path when getPath is called without a custom impl */
  userDataPath?: string;
  /** Key-aware getPath; overrides userDataPath when provided */
  getPathImpl?: (name: string) => string;
  isPackaged?: boolean;
  getAppPath?: string;

  /** false | true (plain vi.fn) | 'registry' (Map capture) */
  ipc?: false | true | 'registry';
  removeHandler?: boolean;

  /** false | 'stub' (on/off vi.fn) | 'emitter' (real EventEmitter) */
  powerMonitor?: false | 'stub' | 'emitter';

  shell?: boolean;
  dialog?: boolean;
  clipboard?: boolean;

  /** Escape hatch — merged last onto the module export */
  overrides?: Record<string, unknown>;
}

export interface ElectronHarness {
  /** Pass to vi.mock: () => harness.module */
  module: Record<string, unknown>;
  app: {
    getPath: Mock<(name: string) => string>;
    getAppPath: Mock<() => string>;
    isPackaged: boolean;
  };
  ipcMain?: {
    handle: Mock;
    removeHandler?: Mock;
  };
  ipcHandlers: Map<string, IpcHandler>;
  powerMonitor?: { on: Mock; off: Mock } | EventEmitter;
  shell?: { openPath: Mock };
  dialog?: { showOpenDialog: Mock };
  clipboard?: { writeText: Mock; writeBuffer: Mock };
}

const DEFAULT_USER_DATA = '/tmp/aio-test-user-data';

export function createElectronHarness(
  opts: ElectronHarnessOptions = {},
): ElectronHarness {
  const ipcHandlers = new Map<string, IpcHandler>();

  const getPath = vi.fn((name: string) =>
    opts.getPathImpl?.(name)
      ?? (name === 'userData'
        ? (opts.userDataPath ?? DEFAULT_USER_DATA)
        : `/tmp/aio-test-${name}`),
  );

  const harness: ElectronHarness = {
    ipcHandlers,
    app: {
      getPath,
      getAppPath: vi.fn(() => opts.getAppPath ?? '/tmp/aio-test-app'),
      isPackaged: opts.isPackaged ?? false,
    },
    module: {},
  };

  if (opts.ipc) {
    const handle =
      opts.ipc === 'registry'
        ? vi.fn((channel: string, handler: IpcHandler) => {
            ipcHandlers.set(channel, handler);
          })
        : vi.fn();
    harness.ipcMain = {
      handle,
      ...(opts.removeHandler ? { removeHandler: vi.fn() } : {}),
    };
  }

  if (opts.powerMonitor === 'emitter') {
    harness.powerMonitor = new EventEmitter();
  } else if (opts.powerMonitor === 'stub') {
    harness.powerMonitor = { on: vi.fn(), off: vi.fn() };
  }

  if (opts.shell) {
    harness.shell = { openPath: vi.fn().mockResolvedValue('') };
  }
  if (opts.dialog) {
    harness.dialog = { showOpenDialog: vi.fn() };
  }
  if (opts.clipboard) {
    harness.clipboard = { writeText: vi.fn(), writeBuffer: vi.fn() };
  }

  harness.module = {
    app: harness.app,
    ...(harness.ipcMain ? { ipcMain: harness.ipcMain } : {}),
    ...(harness.powerMonitor ? { powerMonitor: harness.powerMonitor } : {}),
    ...(harness.shell ? { shell: harness.shell } : {}),
    ...(harness.dialog ? { dialog: harness.dialog } : {}),
    ...(harness.clipboard ? { clipboard: harness.clipboard } : {}),
    ...opts.overrides,
  };

  return harness;
}

/** Find handler from ipcMain.handle mock.calls (terminal-handlers style) */
export function getIpcHandlerFromMock(
  ipcMain: { handle: Mock },
  channel: string,
): IpcHandler {
  const call = ipcMain.handle.mock.calls.find(([ch]) => ch === channel);
  if (!call) throw new Error(`no ipc handler registered for ${channel}`);
  return call[1] as IpcHandler;
}

/** Find handler from registry Map (state-resync style) */
export function getIpcHandlerFromRegistry(
  handlers: Map<string, IpcHandler>,
  channel: string,
): IpcHandler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no ipc handler registered for ${channel}`);
  return handler;
}
