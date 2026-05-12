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

const trashItemMock = vi.fn().mockResolvedValue(undefined);

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
  shell: {
    trashItem: (...args: unknown[]) => trashItemMock(...args),
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
  discardTracked: vi
    .fn()
    .mockResolvedValue({ stdout: '', stderr: '', durationMs: 9, exitCode: 0, args: ['restore'], cwd: '/work' }),
  commit: vi
    .fn()
    .mockResolvedValue({ stdout: 'committed', stderr: '', durationMs: 20, exitCode: 0, args: ['commit'], cwd: '/work' }),
  fetch: vi
    .fn()
    .mockResolvedValue({ stdout: '', stderr: '', durationMs: 50, exitCode: 0, args: ['fetch'], cwd: '/work' }),
  pullFastForward: vi
    .fn()
    .mockResolvedValue({ stdout: '', stderr: '', durationMs: 75, exitCode: 0, args: ['pull'], cwd: '/work' }),
  push: vi
    .fn()
    .mockResolvedValue({ stdout: '', stderr: '', durationMs: 110, exitCode: 0, args: ['push'], cwd: '/work' }),
  checkoutBranch: vi
    .fn()
    .mockResolvedValue({ success: true, result: { stdout: '', stderr: '', durationMs: 10, exitCode: 0, args: ['checkout'], cwd: '/work' } }),
  isGitRepository: vi.fn().mockReturnValue(true),
  findGitRoot: vi.fn().mockReturnValue('/work'),
  getStatus: vi.fn(() => ({
    branch: 'main',
    ahead: 0,
    behind: 0,
    staged: [{ path: 'staged.txt', status: 'modified', staged: true }],
    unstaged: [{ path: 'a.txt', status: 'modified', staged: false }],
    untracked: ['new.txt'],
    hasChanges: true,
    isClean: false,
  })),
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
    trashItemMock.mockClear();
    trashItemMock.mockResolvedValue(undefined);
    fakeManager.stageFiles.mockClear();
    fakeManager.unstageFiles.mockClear();
    fakeManager.discardTracked.mockClear();
    fakeManager.commit.mockClear();
    fakeManager.fetch.mockClear();
    fakeManager.pullFastForward.mockClear();
    fakeManager.push.mockClear();
    fakeManager.checkoutBranch.mockClear();
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
    fakeManager.discardTracked.mockResolvedValue({
      stdout: '',
      stderr: '',
      durationMs: 9,
      exitCode: 0,
      args: ['restore', '--source=HEAD', '--staged', '--worktree', '--'],
      cwd: '/work',
    });
    fakeManager.commit.mockResolvedValue({
      stdout: '[main abc] commit',
      stderr: '',
      durationMs: 20,
      exitCode: 0,
      args: ['commit', '-m', 'x'],
      cwd: '/work',
    });
    fakeManager.fetch.mockResolvedValue({
      stdout: '',
      stderr: '',
      durationMs: 50,
      exitCode: 0,
      args: ['fetch', '--prune'],
      cwd: '/work',
    });
    fakeManager.pullFastForward.mockResolvedValue({
      stdout: 'Already up to date.',
      stderr: '',
      durationMs: 75,
      exitCode: 0,
      args: ['pull', '--ff-only'],
      cwd: '/work',
    });
    fakeManager.push.mockResolvedValue({
      stdout: '',
      stderr: '',
      durationMs: 110,
      exitCode: 0,
      args: ['push'],
      cwd: '/work',
    });
    fakeManager.checkoutBranch.mockResolvedValue({
      success: true,
      result: { stdout: '', stderr: '', durationMs: 10, exitCode: 0, args: ['checkout'], cwd: '/work' },
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

  // ---------------------------------------------------------------
  // VCS_DISCARD_FILES (Phase 2d item 8)
  // ---------------------------------------------------------------
  describe('VCS_DISCARD_FILES', () => {
    it('routes tracked paths through discardTracked and untracked paths through shell.trashItem', async () => {
      // The fake status reports:
      //   staged:   staged.txt
      //   unstaged: a.txt
      //   untracked: new.txt
      const res = await invoke(IPC_CHANNELS.VCS_DISCARD_FILES, {
        workingDirectory: '/work',
        filePaths: ['a.txt', 'new.txt'],
      });

      expect(res.success).toBe(true);
      expect(fakeManager.discardTracked).toHaveBeenCalledWith(['a.txt']);
      expect(trashItemMock).toHaveBeenCalledTimes(1);
      // shell.trashItem receives an absolute path resolved against cwd.
      expect(trashItemMock.mock.calls[0][0]).toMatch(/[\\/]work[\\/]new\.txt$/);
      expect(res.data?.discardedTracked).toBe(1);
      expect(res.data?.discardedUntracked).toBe(1);
    });

    it('does not call git when only untracked paths are passed', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_DISCARD_FILES, {
        workingDirectory: '/work',
        filePaths: ['new.txt'],
      });
      expect(res.success).toBe(true);
      expect(fakeManager.discardTracked).not.toHaveBeenCalled();
      expect(trashItemMock).toHaveBeenCalledTimes(1);
    });

    it('returns a structured error when git is not available', async () => {
      gitAvailable = false;
      const res = await invoke(IPC_CHANNELS.VCS_DISCARD_FILES, {
        workingDirectory: '/work',
        filePaths: ['a.txt'],
      });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('VCS_DISCARD_FILES_FAILED');
    });
  });

  // ---------------------------------------------------------------
  // VCS_COMMIT (Phase 2d item 9)
  // ---------------------------------------------------------------
  describe('VCS_COMMIT', () => {
    it('commits with signoff + amend flags forwarded to the manager', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_COMMIT, {
        workingDirectory: '/work',
        message: 'feat: thing',
        signoff: true,
        amend: false,
      });
      expect(res.success).toBe(true);
      expect(fakeManager.commit).toHaveBeenCalledWith({
        message: 'feat: thing',
        signoff: true,
        amend: false,
      });
    });

    it('rejects an empty message via Zod', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_COMMIT, {
        workingDirectory: '/work',
        message: '',
      });
      expect(res.success).toBe(false);
      expect(fakeManager.commit).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // VCS_FETCH / VCS_PULL / VCS_PUSH (Phase 2d item 10)
  // ---------------------------------------------------------------
  describe('long-running fetch / pull / push', () => {
    it('VCS_FETCH calls manager.fetch and resolves with the stdio envelope', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_FETCH, {
        workingDirectory: '/work',
        opId: 'op-1',
        prune: true,
      });
      expect(res.success).toBe(true);
      expect(fakeManager.fetch).toHaveBeenCalledWith(expect.objectContaining({ prune: true }));
    });

    it('VCS_PULL calls manager.pullFastForward', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_PULL, {
        workingDirectory: '/work',
        opId: 'op-2',
      });
      expect(res.success).toBe(true);
      expect(fakeManager.pullFastForward).toHaveBeenCalled();
    });

    it('VCS_PUSH calls manager.push and forwards forceWithLease', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_PUSH, {
        workingDirectory: '/work',
        opId: 'op-3',
        forceWithLease: true,
        setUpstream: true,
      });
      expect(res.success).toBe(true);
      expect(fakeManager.push).toHaveBeenCalledWith(expect.objectContaining({
        forceWithLease: true,
        setUpstream: true,
      }));
    });

    it('VCS_FETCH rejects a missing opId', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_FETCH, { workingDirectory: '/work' });
      expect(res.success).toBe(false);
      expect(fakeManager.fetch).not.toHaveBeenCalled();
    });

    it('VCS_OPERATION_CANCEL reports unknown opId gracefully', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_OPERATION_CANCEL, { opId: 'no-such' });
      expect(res.success).toBe(true);
      expect(res.data?.cancelled).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // VCS_CHECKOUT_BRANCH (Phase 2d item 11)
  // ---------------------------------------------------------------
  describe('VCS_CHECKOUT_BRANCH', () => {
    it('returns success when the manager succeeds', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_CHECKOUT_BRANCH, {
        workingDirectory: '/work',
        branchName: 'develop',
      });
      expect(res.success).toBe(true);
      expect(fakeManager.checkoutBranch).toHaveBeenCalledWith('develop', { force: undefined });
    });

    it('surfaces a dirty-tree outcome with the dedicated error code', async () => {
      fakeManager.checkoutBranch.mockResolvedValueOnce({
        success: false,
        dirty: true,
        errorMessage: 'your local changes would be overwritten',
      });
      const res = await invoke(IPC_CHANNELS.VCS_CHECKOUT_BRANCH, {
        workingDirectory: '/work',
        branchName: 'develop',
      });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('VCS_CHECKOUT_BRANCH_DIRTY_TREE');
      expect((res as IpcResponse<{ dirty: boolean }>).data?.dirty).toBe(true);
    });

    it('forwards force: true when requested', async () => {
      await invoke(IPC_CHANNELS.VCS_CHECKOUT_BRANCH, {
        workingDirectory: '/work',
        branchName: 'develop',
        force: true,
      });
      expect(fakeManager.checkoutBranch).toHaveBeenCalledWith('develop', { force: true });
    });

    it('rejects payload missing branchName', async () => {
      const res = await invoke(IPC_CHANNELS.VCS_CHECKOUT_BRANCH, {
        workingDirectory: '/work',
      });
      expect(res.success).toBe(false);
      expect(fakeManager.checkoutBranch).not.toHaveBeenCalled();
    });
  });
});
