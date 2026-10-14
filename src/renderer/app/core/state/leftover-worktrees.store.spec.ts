import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { IPC_CHANNELS } from '@contracts/channels';
import type { LeftoverRemovalPreview } from '@contracts/schemas/workspace-tools';
import { LeftoverWorktreesStore } from './leftover-worktrees.store';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';

const preview: LeftoverRemovalPreview = { previewId: 'preview', action: 'discard-saved-work', consequence: 'Discard 2 files',
  row: { repoRoot: '/repo', path: '/repo/.worktrees/old', branch: 'old', tip: 'fixture-tip', createdBy: 'harness',
    owner: null, inUse: false, leftover: true, category: 'saved-work', removableByHarness: true, reason: null,
    dirtyCount: 0, ahead: 1, behind: 0, patchCount: 1, fileCount: 2, mergedIntoMain: false,
    lastCommitAt: 0, ageDays: 30, bytes: 0, sentence: 'Saved work' } };
describe('leftover folder store', () => {
  const invoke = vi.fn();
  beforeEach(() => {
    invoke.mockReset();
    TestBed.configureTestingModule({ providers: [{ provide: ElectronIpcService, useValue: { invoke } }] });
  });
  it('uses the preview ticket and explicit discard flag, then refreshes the report', async () => {
    invoke.mockImplementation(async (channel: string) => ({ success: true, data: channel === IPC_CHANNELS.WORKTREE_LEFTOVERS_PREVIEW
      ? preview : channel === IPC_CHANNELS.WORKTREE_LEFTOVERS_LIST ? { rows: [], errors: [] } : {} }));
    const store = TestBed.inject(LeftoverWorktreesStore);
    await store.review(preview.row, preview.action);
    await store.run(false);
    expect(store.preview()).toEqual(preview);
    await store.run(true);
    expect(store.preview()).toBeNull(); expect(store.rows()).toEqual([]); expect(store.busy()).toBe(false);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.WORKTREE_LEFTOVERS_REMOVE, {
      repoRoot: '/repo', path: '/repo/.worktrees/old', action: 'discard-saved-work', previewId: 'preview', discardSavedWork: true,
    });
  });
  it('does not resurrect a preview that resolves after Cancel', async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const store = TestBed.inject(LeftoverWorktreesStore);
    const reviewing = store.review(preview.row, preview.action);
    store.cancel(); finish({ success: true, data: preview }); await reviewing;
    expect(store.preview()).toBeNull(); expect(store.busy()).toBe(false);
  });
  it('reports failed removal and requires another review', async () => {
    invoke.mockResolvedValueOnce({ success: true, data: preview });
    invoke.mockResolvedValueOnce({ success: false, error: { message: 'Folder changed' } });
    const store = TestBed.inject(LeftoverWorktreesStore);
    await store.review(preview.row, preview.action); await store.run(true);
    expect(store.error()).toBe('Folder changed'); expect(store.preview()).toBeNull();
  });
});
