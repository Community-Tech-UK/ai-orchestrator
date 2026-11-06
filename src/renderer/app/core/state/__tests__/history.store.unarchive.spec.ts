import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationHistoryEntry } from '../../../../../shared/types/history.types';
import { HistoryIpcService } from '../../services/ipc/history-ipc.service';
import { HistoryStore } from '../history.store';
describe('HistoryStore unarchive', () => {
  const unarchiveHistoryEntry = vi.fn();
  let store: HistoryStore;
  beforeEach(async () => {
    unarchiveHistoryEntry.mockReset().mockResolvedValue({ success: true });
    TestBed.configureTestingModule({ providers: [{ provide: HistoryIpcService, useValue: {
      unarchiveHistoryEntry, listHistory: async () => ({ success: true, data: [{ id: 'entry', displayName: 'Entry', archivedAt: 1 } as ConversationHistoryEntry] }),
    } }] }); store = TestBed.inject(HistoryStore); await store.loadHistory();
  });
  it('clears archive state only after a successful validated response', async () => {
    expect(await store.unarchiveEntry('entry')).toBe(true); expect(unarchiveHistoryEntry).toHaveBeenCalledWith('entry');
    expect(store.entries()[0].archivedAt).toBeUndefined();
  });
  it('keeps archive state when an entry was deleted in the meantime', async () => {
    unarchiveHistoryEntry.mockResolvedValue({ success: false, error: { message: 'Unavailable' } });
    expect(await store.unarchiveEntry('entry')).toBe(false); expect(store.entries()[0].archivedAt).toBe(1);
    expect(store.error()).toBe('Unavailable');
  });
});
