/**
 * Tests for file-handlers (editor / watcher / multi-edit IPC surface).
 *
 * Strategy: mock `electron` so ipcMain.handle captures handlers; mock the
 * editor/watcher/multi-edit managers so we can drive deterministic behavior;
 * then invoke the captured handlers directly and assert on the IpcResponse
 * envelope (schema validation errors, success data, downstream calls).
 *
 * Note: raw file read/write/dir handlers (FILE_READ_TEXT, FILE_WRITE_TEXT,
 * FILE_READ_DIR) live in `app-handlers.ts` and are tested there; this file
 * is the editor/watcher/multiedit surface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';
import { EventEmitter } from 'events';

// ============================================================
// 1. Mock electron BEFORE any import that transitively needs it
// ============================================================

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
  app: { getPath: () => '/tmp/test' },
}));

// ============================================================
// 2. Logger mock (no-op)
// ============================================================

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// ============================================================
// 3. Mock managers
// ============================================================

const editorManagerMock = {
  detectEditors: vi.fn().mockResolvedValue([
    { type: 'vscode', name: 'VS Code', path: '/usr/bin/code' },
  ]),
  openFile: vi.fn().mockResolvedValue({ opened: true }),
  openFileAtLine: vi.fn().mockResolvedValue({ opened: true }),
  openDirectory: vi.fn().mockResolvedValue({ opened: true }),
  setPreferredEditor: vi.fn(),
  getPreferredEditor: vi
    .fn()
    .mockReturnValue({ type: 'vscode', path: '/usr/bin/code' }),
  getAvailableEditors: vi
    .fn()
    .mockReturnValue([{ type: 'vscode', path: '/usr/bin/code' }]),
};

vi.mock('../../../workspace/editor/external-editor', () => ({
  getExternalEditorManager: () => editorManagerMock,
}));

class FakeWatcherManager extends EventEmitter {
  watch = vi.fn().mockResolvedValue('session-1');
  unwatch = vi.fn().mockResolvedValue(undefined);
  unwatchAll = vi.fn().mockResolvedValue(undefined);
  getActiveSessions = vi.fn().mockReturnValue(['session-1']);
  getRecentChanges = vi.fn().mockReturnValue([{ path: '/a', type: 'added' }]);
  clearEventBuffer = vi.fn();
}
const watcherManagerMock = new FakeWatcherManager();

vi.mock('../../../workspace/watcher/file-watcher', () => ({
  getFileWatcherManager: () => watcherManagerMock,
}));

const multiEditMock = {
  preview: vi.fn().mockResolvedValue({ diffs: [] }),
  apply: vi.fn().mockResolvedValue({ success: true, applied: 1 }),
};

vi.mock('../../../workspace/multiedit-manager', () => ({
  getMultiEditManager: () => multiEditMock,
}));

// ============================================================
// 4. Import SUT (after mocks are registered)
// ============================================================

import { registerFileHandlers } from '../file-handlers';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';
import type { WindowManager } from '../../../window-manager';

// ============================================================
// 5. Helpers
// ============================================================

async function invoke(
  channel: string,
  payload?: unknown
): Promise<IpcResponse<Record<string, unknown>>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel: ${channel}`);
  return handler({}, payload) as Promise<IpcResponse<Record<string, unknown>>>;
}

function makeMockWindowManager(): WindowManager {
  const fakeWindow = { webContents: { send: vi.fn() } };
  return {
    getMainWindow: vi.fn().mockReturnValue(fakeWindow),
  } as unknown as WindowManager;
}

// ============================================================
// 6. Tests
// ============================================================

describe('file-handlers', () => {
  let windowManager: WindowManager;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    watcherManagerMock.removeAllListeners();
    windowManager = makeMockWindowManager();
    registerFileHandlers({ windowManager });
  });

  // ----------------------------------------------------------
  // EDITOR_DETECT (no payload)
  // ----------------------------------------------------------
  describe('EDITOR_DETECT', () => {
    it('returns detected editors', async () => {
      const res = await invoke(IPC_CHANNELS.EDITOR_DETECT);
      expect(res.success).toBe(true);
      expect(editorManagerMock.detectEditors).toHaveBeenCalled();
      expect(res.data).toEqual([
        { type: 'vscode', name: 'VS Code', path: '/usr/bin/code' },
      ]);
    });

    it('returns structured error when manager throws', async () => {
      editorManagerMock.detectEditors.mockRejectedValueOnce(new Error('boom'));
      const res = await invoke(IPC_CHANNELS.EDITOR_DETECT);
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('EDITOR_DETECT_FAILED');
      expect(res.error?.message).toBe('boom');
    });
  });

  // ----------------------------------------------------------
  // EDITOR_OPEN_FILE (Zod-validated payload)
  // ----------------------------------------------------------
  describe('EDITOR_OPEN_FILE', () => {
    it('opens file with validated payload', async () => {
      const res = await invoke(IPC_CHANNELS.EDITOR_OPEN_FILE, {
        filePath: '/tmp/test-cwd/file.ts',
        line: 42,
        column: 10,
      });
      expect(res.success).toBe(true);
      expect(editorManagerMock.openFile).toHaveBeenCalledWith(
        '/tmp/test-cwd/file.ts',
        expect.objectContaining({ line: 42, column: 10 })
      );
    });

    it('rejects invalid payload with structured error', async () => {
      const res = await invoke(IPC_CHANNELS.EDITOR_OPEN_FILE, {
        // missing required filePath
        line: 1,
      });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('EDITOR_OPEN_FILE_FAILED');
      expect(editorManagerMock.openFile).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // EDITOR_OPEN_DIRECTORY
  // ----------------------------------------------------------
  describe('EDITOR_OPEN_DIRECTORY', () => {
    it('opens directory with validated payload', async () => {
      const res = await invoke(IPC_CHANNELS.EDITOR_OPEN_DIRECTORY, {
        dirPath: '/tmp/test-cwd',
      });
      expect(res.success).toBe(true);
      expect(editorManagerMock.openDirectory).toHaveBeenCalledWith(
        '/tmp/test-cwd'
      );
    });

    it('rejects empty payload', async () => {
      const res = await invoke(IPC_CHANNELS.EDITOR_OPEN_DIRECTORY, {});
      expect(res.success).toBe(false);
      expect(editorManagerMock.openDirectory).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // EDITOR_GET_PREFERRED (no payload)
  // ----------------------------------------------------------
  describe('EDITOR_GET_PREFERRED', () => {
    it('returns preferred editor', async () => {
      const res = await invoke(IPC_CHANNELS.EDITOR_GET_PREFERRED);
      expect(res.success).toBe(true);
      expect(res.data).toEqual({ type: 'vscode', path: '/usr/bin/code' });
    });
  });

  // ----------------------------------------------------------
  // WATCHER_START
  // ----------------------------------------------------------
  describe('WATCHER_START', () => {
    it('starts watching a directory with validated payload', async () => {
      const res = await invoke(IPC_CHANNELS.WATCHER_START, {
        directory: '/tmp/test-cwd',
      });
      expect(res.success).toBe(true);
      expect(watcherManagerMock.watch).toHaveBeenCalledWith(
        '/tmp/test-cwd',
        expect.any(Object)
      );
      expect(res.data).toEqual({ sessionId: 'session-1' });
    });

    it('rejects payload missing directory', async () => {
      const res = await invoke(IPC_CHANNELS.WATCHER_START, {});
      expect(res.success).toBe(false);
      expect(watcherManagerMock.watch).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // WATCHER_STOP
  // ----------------------------------------------------------
  describe('WATCHER_STOP', () => {
    it('stops an active watcher session', async () => {
      const res = await invoke(IPC_CHANNELS.WATCHER_STOP, {
        sessionId: 'session-1',
      });
      expect(res.success).toBe(true);
      expect(watcherManagerMock.unwatch).toHaveBeenCalledWith('session-1');
    });

    it('rejects payload without sessionId', async () => {
      const res = await invoke(IPC_CHANNELS.WATCHER_STOP, {});
      expect(res.success).toBe(false);
      expect(watcherManagerMock.unwatch).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // WATCHER_GET_SESSIONS (no payload)
  // ----------------------------------------------------------
  describe('WATCHER_GET_SESSIONS', () => {
    it('returns active watcher sessions', async () => {
      const res = await invoke(IPC_CHANNELS.WATCHER_GET_SESSIONS);
      expect(res.success).toBe(true);
      expect(res.data).toEqual(['session-1']);
    });
  });

  // ----------------------------------------------------------
  // WATCHER event forwarding
  // ----------------------------------------------------------
  describe('watcher event forwarding', () => {
    it('forwards file-changed events to the renderer', () => {
      const mainWindow = windowManager.getMainWindow()!;
      const sendSpy = mainWindow.webContents.send as unknown as ReturnType<
        typeof vi.fn
      >;

      watcherManagerMock.emit('file-changed', {
        path: '/x',
        type: 'change',
      });

      expect(sendSpy).toHaveBeenCalledWith(
        IPC_CHANNELS.WATCHER_FILE_CHANGED,
        { path: '/x', type: 'change' }
      );
    });

    it('forwards watcher error events on the dedicated channel', () => {
      const mainWindow = windowManager.getMainWindow()!;
      const sendSpy = mainWindow.webContents.send as unknown as ReturnType<
        typeof vi.fn
      >;

      watcherManagerMock.emit('error', { message: 'oops' });

      expect(sendSpy).toHaveBeenCalledWith(
        IPC_CHANNELS.WATCHER_ERROR,
        { message: 'oops' }
      );
    });
  });

  // ----------------------------------------------------------
  // MULTIEDIT_PREVIEW / MULTIEDIT_APPLY
  // ----------------------------------------------------------
  describe('MULTIEDIT_PREVIEW', () => {
    it('previews valid multi-edit payload', async () => {
      const res = await invoke(IPC_CHANNELS.MULTIEDIT_PREVIEW, {
        edits: [
          {
            filePath: '/tmp/a.ts',
            oldString: 'foo',
            newString: 'bar',
          },
        ],
      });
      expect(res.success).toBe(true);
      expect(multiEditMock.preview).toHaveBeenCalled();
    });

    it('rejects payload missing edits', async () => {
      const res = await invoke(IPC_CHANNELS.MULTIEDIT_PREVIEW, {});
      expect(res.success).toBe(false);
      expect(multiEditMock.preview).not.toHaveBeenCalled();
    });
  });

  describe('MULTIEDIT_APPLY', () => {
    it('applies valid multi-edit payload', async () => {
      const res = await invoke(IPC_CHANNELS.MULTIEDIT_APPLY, {
        edits: [
          {
            filePath: '/tmp/a.ts',
            oldString: 'foo',
            newString: 'bar',
          },
        ],
        takeSnapshots: true,
      });
      expect(res.success).toBe(true);
      expect(multiEditMock.apply).toHaveBeenCalled();
    });

    it('propagates manager-level failure in the envelope', async () => {
      multiEditMock.apply.mockResolvedValueOnce({
        success: false,
        error: 'conflict',
      });
      const res = await invoke(IPC_CHANNELS.MULTIEDIT_APPLY, {
        edits: [
          {
            filePath: '/tmp/a.ts',
            oldString: 'foo',
            newString: 'bar',
          },
        ],
      });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('MULTIEDIT_APPLY_FAILED');
      expect(res.error?.message).toBe('conflict');
    });
  });
});
