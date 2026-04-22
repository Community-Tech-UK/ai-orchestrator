/**
 * Tests for app-handlers — focused on the file-IO security surface.
 *
 * This is the spec the WS5 plan asked for under "file-handlers spec":
 * path-sandbox validation, path-traversal rejection, size-bounded reads,
 * createDirs on write. The actual file-IO handlers live in app-handlers.ts
 * (FILE_READ_TEXT, FILE_WRITE_TEXT, FILE_READ_DIR, FILE_GET_STATS,
 * FILE_OPEN_PATH); the file-handlers.ts module covers editor/watcher/
 * multi-edit and is tested separately.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';

// ============================================================
// 1. Mock electron BEFORE any import that would pull it in
// ============================================================

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  shell: {
    openPath: vi.fn().mockResolvedValue(''),
  },
  app: {
    getPath: () => '/tmp/test',
    getAppPath: () => '/tmp/test-app',
  },
}));

// ============================================================
// 2. Logger mock
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
// 3. Mock path-validator — drives sandbox accept/reject behavior
// ============================================================

const validatePathMock = vi.fn();

vi.mock('../../../security/path-validator', () => ({
  validatePath: (p: string) => validatePathMock(p),
  initializePathValidator: vi.fn(),
  addAllowedRoot: vi.fn(),
}));

// ============================================================
// 4. Mock fs/promises — drives read/write/readdir/stat behavior
// ============================================================

const fsReadFile = vi.fn();
const fsWriteFile = vi.fn();
const fsReadDir = vi.fn();
const fsStat = vi.fn();
const fsMkdir = vi.fn();

vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => fsReadFile(...args),
  writeFile: (...args: unknown[]) => fsWriteFile(...args),
  readdir: (...args: unknown[]) => fsReadDir(...args),
  stat: (...args: unknown[]) => fsStat(...args),
  mkdir: (...args: unknown[]) => fsMkdir(...args),
  default: {
    readFile: (...args: unknown[]) => fsReadFile(...args),
    writeFile: (...args: unknown[]) => fsWriteFile(...args),
    readdir: (...args: unknown[]) => fsReadDir(...args),
    stat: (...args: unknown[]) => fsStat(...args),
    mkdir: (...args: unknown[]) => fsMkdir(...args),
  },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  default: {
    existsSync: vi.fn().mockReturnValue(false),
  },
}));

// ============================================================
// 5. Import SUT (after mocks are registered)
// ============================================================

import { registerAppHandlers } from '../app-handlers';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';
import type { WindowManager } from '../../../window-manager';

// ============================================================
// 6. Helpers
// ============================================================

async function invoke(
  channel: string,
  payload?: unknown
): Promise<IpcResponse<Record<string, unknown>>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel: ${channel}`);
  return handler({
    sender: {
      send: vi.fn(),
    },
  }, payload) as Promise<IpcResponse<Record<string, unknown>>>;
}

function makeMockWindowManager(): WindowManager {
  return {} as unknown as WindowManager;
}

// ============================================================
// 7. Tests
// ============================================================

describe('app-handlers (file IO security surface)', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    // Default: path validator accepts every path
    validatePathMock.mockImplementation((p: string) => ({
      valid: true,
      resolved: p,
    }));

    registerAppHandlers({
      windowManager: makeMockWindowManager(),
      getIpcAuthToken: () => 'test-token',
    });
  });

  // ----------------------------------------------------------
  // FILE_READ_TEXT
  // ----------------------------------------------------------
  describe('FILE_READ_TEXT', () => {
    it('reads file content within size limit', async () => {
      const content = Buffer.from('hello world', 'utf-8');
      fsReadFile.mockResolvedValue(content);

      const res = await invoke(IPC_CHANNELS.FILE_READ_TEXT, {
        path: '/tmp/test/file.txt',
        maxBytes: 1024,
      });

      expect(res.success).toBe(true);
      expect(res.data).toMatchObject({
        path: '/tmp/test/file.txt',
        content: 'hello world',
        truncated: false,
        size: content.byteLength,
      });
      expect(validatePathMock).toHaveBeenCalledWith('/tmp/test/file.txt');
      expect(fsReadFile).toHaveBeenCalledWith('/tmp/test/file.txt');
    });

    it('rejects path traversal via the path validator', async () => {
      validatePathMock.mockReturnValue({
        valid: false,
        resolved: '/etc/passwd',
        error: 'Path outside allowed directories: /etc/passwd',
      });

      const res = await invoke(IPC_CHANNELS.FILE_READ_TEXT, {
        path: '../../../etc/passwd',
      });

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('PATH_VALIDATION_FAILED');
      expect(res.error?.message).toContain('outside allowed directories');
      expect(fsReadFile).not.toHaveBeenCalled();
    });

    it('truncates content that exceeds maxBytes', async () => {
      const content = Buffer.from('a'.repeat(2048), 'utf-8');
      fsReadFile.mockResolvedValue(content);

      const res = await invoke(IPC_CHANNELS.FILE_READ_TEXT, {
        path: '/tmp/test/big.txt',
        maxBytes: 100,
      });

      expect(res.success).toBe(true);
      const data = res.data as { content: string; truncated: boolean; size: number };
      expect(data.truncated).toBe(true);
      expect(data.content.length).toBe(100);
      expect(data.size).toBe(2048);
    });

    it('rejects payload with missing path', async () => {
      const res = await invoke(IPC_CHANNELS.FILE_READ_TEXT, {});
      expect(res.success).toBe(false);
      expect(fsReadFile).not.toHaveBeenCalled();
    });

    it('rejects payload with maxBytes above the upper limit', async () => {
      const res = await invoke(IPC_CHANNELS.FILE_READ_TEXT, {
        path: '/tmp/test/file.txt',
        maxBytes: 100 * 1024 * 1024, // 100 MB — schema cap is 5 MB
      });
      expect(res.success).toBe(false);
      expect(fsReadFile).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // FILE_WRITE_TEXT
  // ----------------------------------------------------------
  describe('FILE_WRITE_TEXT', () => {
    it('writes file content with valid payload', async () => {
      fsWriteFile.mockResolvedValue(undefined);

      const res = await invoke(IPC_CHANNELS.FILE_WRITE_TEXT, {
        path: '/tmp/test/out.txt',
        content: 'hello',
      });

      expect(res.success).toBe(true);
      expect(fsWriteFile).toHaveBeenCalledWith(
        '/tmp/test/out.txt',
        'hello',
        'utf-8'
      );
    });

    it('rejects path traversal via the path validator', async () => {
      validatePathMock.mockReturnValue({
        valid: false,
        resolved: '/etc/passwd',
        error: 'Path outside allowed directories',
      });

      const res = await invoke(IPC_CHANNELS.FILE_WRITE_TEXT, {
        path: '../../../etc/passwd',
        content: 'malicious',
      });

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('PATH_VALIDATION_FAILED');
      expect(fsWriteFile).not.toHaveBeenCalled();
    });

    it('creates parent directories when createDirs=true', async () => {
      fsMkdir.mockResolvedValue(undefined);
      fsWriteFile.mockResolvedValue(undefined);

      const res = await invoke(IPC_CHANNELS.FILE_WRITE_TEXT, {
        path: '/tmp/test/new-dir/out.txt',
        content: 'hi',
        createDirs: true,
      });

      expect(res.success).toBe(true);
      expect(fsMkdir).toHaveBeenCalledWith('/tmp/test/new-dir', {
        recursive: true,
      });
      expect(fsWriteFile).toHaveBeenCalled();
    });

    it('does not create parent directories when createDirs is omitted', async () => {
      fsWriteFile.mockResolvedValue(undefined);

      await invoke(IPC_CHANNELS.FILE_WRITE_TEXT, {
        path: '/tmp/test/out.txt',
        content: 'hi',
      });

      expect(fsMkdir).not.toHaveBeenCalled();
    });

    it('rejects content that exceeds the schema limit', async () => {
      const huge = 'a'.repeat(50 * 1024 * 1024 + 1);
      const res = await invoke(IPC_CHANNELS.FILE_WRITE_TEXT, {
        path: '/tmp/test/out.txt',
        content: huge,
      });
      expect(res.success).toBe(false);
      expect(fsWriteFile).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // FILE_READ_DIR
  // ----------------------------------------------------------
  describe('FILE_READ_DIR', () => {
    it('lists directory entries (dirs first, then files)', async () => {
      interface FakeDirent {
        name: string;
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
        isFile: () => boolean;
      }
      const dirent = (name: string, isDir: boolean): FakeDirent => ({
        name,
        isDirectory: () => isDir,
        isSymbolicLink: () => false,
        isFile: () => !isDir,
      });
      fsReadDir.mockResolvedValue([
        dirent('zeta.txt', false),
        dirent('alpha-dir', true),
        dirent('readme.md', false),
      ]);
      fsStat.mockResolvedValue({
        size: 1,
        mtimeMs: 0,
      });

      const res = await invoke(IPC_CHANNELS.FILE_READ_DIR, {
        path: '/tmp/test/proj',
      });

      expect(res.success).toBe(true);
      const entries = res.data as { name: string; isDirectory: boolean }[];
      expect(entries[0]!.name).toBe('alpha-dir');
      expect(entries[0]!.isDirectory).toBe(true);
      expect(entries[1]!.name).toBe('readme.md');
      expect(entries[2]!.name).toBe('zeta.txt');
    });

    it('skips hidden files when includeHidden is false', async () => {
      const dirent = (name: string) => ({
        name,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        isFile: () => true,
      });
      fsReadDir.mockResolvedValue([dirent('.hidden'), dirent('visible.txt')]);
      fsStat.mockResolvedValue({ size: 1, mtimeMs: 0 });

      const res = await invoke(IPC_CHANNELS.FILE_READ_DIR, {
        path: '/tmp/test/proj',
        includeHidden: false,
      });

      const entries = res.data as { name: string }[];
      expect(entries.map((e) => e.name)).toEqual(['visible.txt']);
    });

    it('includes hidden files when includeHidden is true', async () => {
      const dirent = (name: string) => ({
        name,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        isFile: () => true,
      });
      fsReadDir.mockResolvedValue([dirent('.hidden'), dirent('visible.txt')]);
      fsStat.mockResolvedValue({ size: 1, mtimeMs: 0 });

      const res = await invoke(IPC_CHANNELS.FILE_READ_DIR, {
        path: '/tmp/test/proj',
        includeHidden: true,
      });

      const entries = res.data as { name: string }[];
      expect(entries.map((e) => e.name).sort()).toEqual([
        '.hidden',
        'visible.txt',
      ]);
    });
  });

  // ----------------------------------------------------------
  // APP_READY (returns ipc auth token — no payload)
  // ----------------------------------------------------------
  describe('APP_READY', () => {
    it('returns version and ipc auth token', async () => {
      const res = await invoke(IPC_CHANNELS.APP_READY);
      expect(res.success).toBe(true);
      const data = res.data as { version: string; ipcAuthToken: string };
      expect(data.ipcAuthToken).toBe('test-token');
      expect(data.version).toBeTypeOf('string');
    });
  });
});
