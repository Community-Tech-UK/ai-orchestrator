/**
 * P2 isolation acceptance: when isolateLoopWorkspaces is true and the
 * worktree acquisition fails, loop start must surface a block (reject +
 * write BLOCKED.md) rather than silently falling back to the shared root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../workspace/git/worktree-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/git/worktree-manager')>();
  // Replace getWorktreeManager with a no-default mock so tests set it up themselves.
  // Do NOT call actual.getWorktreeManager() here — that would start a real setInterval.
  return { ...actual, getWorktreeManager: vi.fn() };
});

import { getWorktreeManager } from '../workspace/git/worktree-manager';
import type { WorktreeManager } from '../workspace/git/worktree-manager';
import { LoopCoordinator } from './loop-coordinator';
import { CompletedFileWatcher } from './loop-completion-detector';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-wt-isolation-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  writeFileSync(join(workspace, 'package.json'), '{"name":"loop-wt-isolation"}\n');
  vi.spyOn(CompletedFileWatcher.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompletedFileWatcher.prototype, 'stop').mockResolvedValue();
  vi.spyOn(CompletedFileWatcher.prototype, 'scanOnce').mockReturnValue(null);
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    try { await coordinator.cancelLoop(loop.id); } catch { /* noop */ }
  }
  vi.restoreAllMocks();
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('LoopCoordinator — P2 worktree isolation fail-closed', () => {
  it('createWorktree failure → rejects startLoop and writes BLOCKED.md (never falls back to root)', async () => {
    // Arrange: createWorktree throws (e.g. disk full, lock exists).
    vi.mocked(getWorktreeManager).mockReturnValue({
      createWorktree: vi.fn().mockRejectedValue(new Error('git worktree add failed: lock exists')),
    } as unknown as WorktreeManager);

    // Act + Assert: startLoop must reject (not silently fall back to workspaceCwd).
    await expect(
      coordinator.startLoop('chat-wt-fail', {
        initialPrompt: 'do work',
        workspaceCwd: workspace,
        isolateLoopWorkspaces: true,
      }),
    ).rejects.toThrow('isolateLoopWorkspaces: worktree acquisition failed');

    // BLOCKED.md must be written so the operator can diagnose the failure.
    expect(existsSync(join(workspace, 'BLOCKED.md'))).toBe(true);
    const content = readFileSync(join(workspace, 'BLOCKED.md'), 'utf-8');
    expect(content).toContain('Worktree Acquisition Failed');
    expect(content).toContain('lock exists');
  });

  it('without isolateLoopWorkspaces, createWorktree is never called', async () => {
    const createWorktreeMock = vi.fn().mockRejectedValue(new Error('should not be called'));
    vi.mocked(getWorktreeManager).mockReturnValue({
      createWorktree: createWorktreeMock,
    } as unknown as WorktreeManager);

    // Non-isolated loop: startLoop must NOT call createWorktree.
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      (payload as { callback: (r: { error: string }) => void }).callback({ error: 'test-done' });
    });

    try {
      await coordinator.startLoop('chat-no-isolation', {
        initialPrompt: 'do work',
        workspaceCwd: workspace,
        isolateLoopWorkspaces: false,
      });
    } catch {
      // May error for other reasons — that's acceptable.
    }

    expect(createWorktreeMock).not.toHaveBeenCalled();
  });
});
