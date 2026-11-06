import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationData, HistoryIndex } from '../../shared/types/history.types';
import { archiveHistoryEntry, unarchiveHistoryEntry } from './history-archive-state';
const invalidate = vi.hoisted(() => vi.fn());
vi.mock('../session/session-recovery-candidate-service', () => ({ getSessionRecoveryCandidateServiceIfInitialized: () => ({ invalidate }) }));
describe('history archive state', () => {
  beforeEach(() => invalidate.mockClear());
  const fixture = () => {
    const index = { version: 1, lastUpdated: 0, entries: [{ id: 'entry' }] } as HistoryIndex;
    const stored: ConversationData = { entry: { id: 'entry', displayName: 'Entry', createdAt: 1, endedAt: 2, workingDirectory: '/project', messageCount: 0, firstUserMessage: '', lastUserMessage: '', status: 'completed', originalInstanceId: 'original', parentId: null, sessionId: 'session' }, messages: [] };
    const saveIndex = vi.fn(async () => undefined);
    const deps = { index, saveIndex, updateConversation: vi.fn(async (_id: string, update: (entry: ConversationData['entry']) => void): Promise<ConversationData | null> => { update(stored.entry); return stored; }) };
    return { deps, index, stored, saveIndex };
  };
  it('persists archive and unarchive, and invalidates recovery candidates', async () => {
    const f = fixture(); expect(await archiveHistoryEntry(f.deps, 'entry')).toBe(true);
    expect(f.index.entries[0].archivedAt).toBeGreaterThan(0);
    expect(f.stored.entry.archivedAt).toBe(f.index.entries[0].archivedAt);
    expect(await unarchiveHistoryEntry(f.deps, 'entry')).toBe(true);
    expect(f.index.entries[0].archivedAt).toBeUndefined(); expect(f.stored.entry.archivedAt).toBeUndefined();
    expect(f.saveIndex).toHaveBeenCalledTimes(2); expect(invalidate).toHaveBeenCalledTimes(2);
  });
  it('rejects missing entries and allows repeated unarchive', async () => {
    const f = fixture(); expect(await unarchiveHistoryEntry(f.deps, 'missing')).toBe(false);
    expect(await archiveHistoryEntry(f.deps, 'missing')).toBe(false);
    expect(await unarchiveHistoryEntry(f.deps, 'entry')).toBe(true);
    expect(f.saveIndex).not.toHaveBeenCalled();
  });
  it('refuses to restore an indexed entry when its conversation is missing or corrupt', async () => {
    const f = fixture(); f.index.entries[0].archivedAt = 10;
    f.deps.updateConversation.mockResolvedValue(null);
    expect(await unarchiveHistoryEntry(f.deps, 'entry')).toBe(false);
    expect(f.index.entries[0].archivedAt).toBe(10);
    expect(f.saveIndex).not.toHaveBeenCalled(); expect(invalidate).not.toHaveBeenCalled();
  });
  it('keeps a failed conversation write archived and retries the next restore', async () => {
    const f = fixture(); f.index.entries[0].archivedAt = 10; f.stored.entry.archivedAt = 10;
    f.deps.updateConversation.mockRejectedValueOnce(new Error('write failed'));
    await expect(unarchiveHistoryEntry(f.deps, 'entry')).rejects.toThrow('write failed');
    expect(f.index.entries[0].archivedAt).toBe(10);
    expect(f.saveIndex).not.toHaveBeenCalled(); expect(invalidate).not.toHaveBeenCalled();
    expect(await unarchiveHistoryEntry(f.deps, 'entry')).toBe(true);
    expect(f.deps.updateConversation).toHaveBeenCalledTimes(2);
  });
  it('rolls back both archive states after an index write fails and retries explicitly', async () => {
    const f = fixture(); f.index.entries[0].archivedAt = 10; f.stored.entry.archivedAt = 10;
    f.saveIndex.mockImplementationOnce(async () => {
      f.index.lastUpdated = 999_999_999_999_999;
      throw new Error('index write failed');
    });
    await expect(unarchiveHistoryEntry(f.deps, 'entry')).rejects.toThrow('index write failed');
    expect(f.index.entries[0].archivedAt).toBe(10); expect(f.stored.entry.archivedAt).toBe(10);
    expect(f.index.lastUpdated).toBe(999_999_999_999_999); expect(invalidate).not.toHaveBeenCalled();
    expect(await unarchiveHistoryEntry(f.deps, 'entry')).toBe(true);
    expect(f.deps.updateConversation).toHaveBeenCalledTimes(3);
    expect(f.saveIndex).toHaveBeenCalledTimes(3);
    expect(f.stored.entry.archivedAt).toBeUndefined();
  });
  it('preserves the original failure if compensation also fails', async () => {
    const f = fixture(); f.index.entries[0].archivedAt = 10; f.stored.entry.archivedAt = 10;
    f.saveIndex.mockRejectedValue(new Error('original index failure'));
    f.deps.updateConversation.mockImplementationOnce(async (_id, update) => {
      update(f.stored.entry); return f.stored;
    }).mockRejectedValueOnce(new Error('compensation failure'));
    await expect(unarchiveHistoryEntry(f.deps, 'entry')).rejects.toThrow('original index failure');
    expect(f.index.entries[0].archivedAt).toBe(10); expect(invalidate).not.toHaveBeenCalled();
  });
  it('does not hide a failed archive or report success on a retry without persistence', async () => {
    const f = fixture(); f.deps.updateConversation.mockRejectedValueOnce(new Error('archive write failed'));
    await expect(archiveHistoryEntry(f.deps, 'entry')).rejects.toThrow('archive write failed');
    expect(f.index.entries[0].archivedAt).toBeUndefined(); expect(invalidate).not.toHaveBeenCalled();
    expect(await archiveHistoryEntry(f.deps, 'entry')).toBe(true);
    expect(f.deps.updateConversation).toHaveBeenCalledTimes(2);
    expect(f.stored.entry.archivedAt).toBe(f.index.entries[0].archivedAt);
  });
  it('compensates a failed archive index write and permits a real retry', async () => {
    const f = fixture(); f.saveIndex.mockRejectedValueOnce(new Error('archive index failed'));
    await expect(archiveHistoryEntry(f.deps, 'entry')).rejects.toThrow('archive index failed');
    expect(f.index.entries[0].archivedAt).toBeUndefined(); expect(f.stored.entry.archivedAt).toBeUndefined();
    expect(await archiveHistoryEntry(f.deps, 'entry')).toBe(true);
    expect(f.deps.updateConversation).toHaveBeenCalledTimes(3);
  });
  it('preserves index-only archiving of an orphan while refusing an impossible Undo', async () => {
    const f = fixture(); f.deps.updateConversation.mockResolvedValue(null);
    expect(await archiveHistoryEntry(f.deps, 'entry')).toBe(true);
    expect(await unarchiveHistoryEntry(f.deps, 'entry')).toBe(false);
    expect(f.index.entries[0].archivedAt).toBeGreaterThan(0);
  });
});
