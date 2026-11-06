import { describe, expect, it, vi } from 'vitest';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { ProjectGroup } from './instance-list.types';
import type { UndoRegistration } from '../../core/services/undo.service';
import { archiveWithUndo, removeProjectWithUndo } from './instance-list-undo';
describe('project rail undo', () => {
  const fixture = () => {
    const history = { archiveEntry: vi.fn(async (_id: string) => true), unarchiveEntry: vi.fn(async (_id: string) => true) };
    const recent = { removeDirectory: vi.fn(async (_id: string) => true), addDirectory: vi.fn(async () => ({ path: '/project' })), pinDirectory: vi.fn(async (_id: string) => true) };
    const undo = { register: vi.fn<(registration: UndoRegistration) => void>() }; const toast = { show: vi.fn(() => 'toast') };
    const reload = vi.fn(async () => undefined);
    return { history, recent, undo, toast, reload };
  };
  it('archives at once and restores through the unarchive API', async () => {
    const f = fixture(); await archiveWithUndo({ id: 'a', displayName: 'A' } as ConversationHistoryEntry, f);
    expect(f.history.archiveEntry).toHaveBeenCalledWith('a'); expect(f.undo.register).toHaveBeenCalledOnce();
    expect(await f.undo.register.mock.calls[0][0].undo()).toBe(true); expect(f.history.unarchiveEntry).toHaveBeenCalledWith('a');
  });
  it('restores exactly the newly archived threads, remote folder and pin', async () => {
    const f = fixture(); const group = { path: '/project', title: 'Project', isPinned: true, liveItems: [], historyItems: [
      { entry: { id: 'a' }, children: [] }, { entry: { id: 'old', archivedAt: 1 }, children: [] }, { entry: { id: 'b' }, children: [] },
    ] } as unknown as ProjectGroup;
    await removeProjectWithUndo(group, 'windows-pc', f);
    expect(f.history.archiveEntry.mock.calls).toEqual([['a'], ['b']]);
    expect(await f.undo.register.mock.calls[0][0].undo()).toBe(true);
    expect(f.history.unarchiveEntry.mock.calls).toEqual([['a'], ['b']]);
    expect(f.recent.addDirectory).toHaveBeenCalledWith('/project', { nodeId: 'windows-pc' });
    expect(f.recent.pinDirectory).toHaveBeenCalledWith('/project', true);
    expect(f.reload).toHaveBeenCalledTimes(2);
  });
  it('keeps successful partial archives undoable if a later operation fails', async () => {
    const f = fixture(); f.history.archiveEntry.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const group = { path: '/project', title: 'Project', liveItems: [], historyItems: [{ entry: { id: 'a' }, children: [] }, { entry: { id: 'b' }, children: [] }] } as unknown as ProjectGroup;
    await removeProjectWithUndo(group, null, f);
    expect(f.undo.register.mock.calls[0][0].message).toContain('archived 1 thread');
    expect(f.recent.removeDirectory).not.toHaveBeenCalled(); expect(f.toast.show).toHaveBeenCalled();
    await f.undo.register.mock.calls[0][0].undo(); expect(f.history.unarchiveEntry.mock.calls).toEqual([['a']]);
  });
});
