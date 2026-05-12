/**
 * VCS IPC handler tests (Phase 2d — stage / unstage).
 *
 * Strategy mirrors `file-handlers.spec.ts`:
 *   1. Mock `electron` so `ipcMain.handle` captures handlers into a Map.
 *   2. Mock the VcsManager factory so spawned `git` calls become
 *      deterministic vi.fn() stubs.
 *   3. Mock the `isGitAvailable` capability gate.
 *   4. Invoke captured handlers directly and assert the IpcResponse
 *      envelope (success, data, error.code), AND the underlying
 *      manager-method calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';

// ============================================================
// 1. Mock electron — before any import that transitively needs it
// ============================================================

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
}));

// ============================================================
// 2. Mock VcsManager factory + isGitAvailable
// ============================================================

const fakeManager = {
  stageFiles: vi
    .fn()
    .mockResolvedValue({ stdout: '', stderr: '', durationMs: 12, exitCode: 0, args: ['add'], cwd: '/work' }),
  unstageFiles: vi
    .fn()
    .mockResolvedValue({ stdout: '', stderr: '', durationMs: 8, exitCode: 0, args: ['restore'], cwd: '/work' }),
  isGitRepository: vi.fn().mockReturnValue(true),
  findGitRoot: vi.fn().mockReturnValue('/work'),
  getStatus: vi.fn(),
  getBranches: vi.fn(),
  getRecentCommits: vi.fn(),
  getFileDiff: vi.fn(),
  getStagedDiff: vi.fn(),
  getUnstagedDiff: vi.fn(),
  getDiffBetween: vi.fn(),
  getDiffStats: vi.fn(),
  getFileHistory: vi.fn(),
  isFileTracked: vi.fn(),
  getFileAtCommit: vi.fn(),
  getBlame: vi.fn(),
  getCurrentBranch: vi.fn(),
};

let gitAvailable = true;

vi.mock('../../../workspace/git/vcs-manager', () => ({
  createVcsManager: vi.fn(() => fakeManager),
  isGitAvailable: vi.fn(() => gitAvailable),
  VcsManager: {
    findRepositories: vi.fn(() => []),
  },
}));

// Watcher singleton — handlers only touch it lazily, so a trivial stub
// is enough for the stage/unstage tests.
const fakeWatcher = {
  on: vi.fn(),
  setRepos: vi.fn().mockResolvedValue(undefined),
  watchedRepos: vi.fn(() => []),
};

vi.mock('../../../workspace/git/git-status-watcher', () => ({
  getGitStatusWatcher: () => fakeWatcher,
}));

// ============================================================
// 3. Logger mock (no-op)
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
// 4. Import SUT after mocks are in place
// ============================================================

import { registerVcsHandlers } from '../vcs-handlers';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';

// ============================================================
// 5. Helpers
// ============================================================

async function invoke(
  channel: string,
  payload?: unknown,
): Promise<IpcResponse<Record<string, unknown>>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel: ${channel}`);
  return handler({}, payload) as Promise<IpcResponse<Record<string, unknown>>>;
}

// ============================================================
// 6. Tests
// ============================================================

describe('vcs-handlers — stage / unstage (Phase 2d)', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    fakeManager.stageFiles.mockClear();
    fakeManager.unstageFiles.mockClear();
    fakeManager.stageFiles.mockResolvedValue({
      stdout: '',
      stderr: '',
      durationMs: 12,
      exitCode: 0,
      args: ['add', '--', 'a.txt'],
      cwd: '/work',
    });
    fakeManager.unstageFiles.mockResolvedValue({
      stdout: '',
      stderr: '',
      durationMs: 8,
      exitCode: 0,
      args: ['restore', '--staged', '--', 'a.txt'],
      cwd: '/work',
    });
    gitAvailable = true;
    registerVcsHandlers();
  });

  // -----------------------------------------------------------
  // VCS_STAGE_FILES
  // -----------------------------------------------------------
  describe('VCS_STAGE_FILES', () => {
    it('stages a file with a valid payload', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_STAGE_FILES, {
        workingDirectory: '/work',
        filePaths: ['a.txt', 'b.txt'],
      });

      expect(res.success).toBe(true);
      expect(fakeManager.stageFiles).toHaveBeenCalledWith(['a.txt', 'b.txt']);
      expect(res.data?.stagedCount).toBe(2);
      expect(res.data?.exitCode).toBe(0);
    });

    it('returns a structured error when git is not available', async () => {
      gitAvailable = false;
      const res = await invoke(IPC_CHANNELS.VCS_STAGE_FILES, {
        workingDirectory: '/work',
        filePaths: ['a.txt'],
      });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('VCS_STAGE_FILES_FAILED');
      expect(res.error?.message).toMatch(/Git is not installed/);
      expect(fakeManager.stageFiles).not.toHaveBeenCalled();
    });

    it('rejects an empty filePaths array via Zod', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_STAGE_FILES, {
        workingDirectory: '/work',
        filePaths: [],
      });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('VCS_STAGE_FILES_FAILED');
      expect(fakeManager.stageFiles).not.toHaveBeenCalled();
    });

    it('rejects a payload missing workingDirectory', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_STAGE_FILES, {
        filePaths: ['a.txt'],
      });
      expect(res.success).toBe(false);
      expect(fakeManager.stageFiles).not.toHaveBeenCalled();
    });

    it('returns a structured error when the manager throws', async () => {
      fakeManager.stageFiles.mockRejectedValueOnce(new Error('git add failed'));
      const res = await invoke(IPC_CHANNELS.VCS_STAGE_FILES, {
        workingDirectory: '/work',
        filePaths: ['a.txt'],
      });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('VCS_STAGE_FILES_FAILED');
      expect(res.error?.message).toBe('git add failed');
    });
  });

  // -----------------------------------------------------------
  // VCS_UNSTAGE_FILES
  // -----------------------------------------------------------
  describe('VCS_UNSTAGE_FILES', () => {
    it('unstages a file with a valid payload', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_UNSTAGE_FILES, {
        workingDirectory: '/work',
        filePaths: ['a.txt'],
      });

      expect(res.success).toBe(true);
      expect(fakeManager.unstageFiles).toHaveBeenCalledWith(['a.txt']);
      expect(res.data?.unstagedCount).toBe(1);
      expect(res.data?.exitCode).toBe(0);
    });

    it('returns a structured error when git is not available', async () => {
      gitAvailable = false;
      const res = await invoke(IPC_CHANNELS.VCS_UNSTAGE_FILES, {
        workingDirectory: '/work',
        filePaths: ['a.txt'],
      });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('VCS_UNSTAGE_FILES_FAILED');
      expect(fakeManager.unstageFiles).not.toHaveBeenCalled();
    });

    it('rejects an empty filePaths array via Zod', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_UNSTAGE_FILES, {
        workingDirectory: '/work',
        filePaths: [],
      });
      expect(res.success).toBe(false);
      expect(fakeManager.unstageFiles).not.toHaveBeenCalled();
    });
  });
});
