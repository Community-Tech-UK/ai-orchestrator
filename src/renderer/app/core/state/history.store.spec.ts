import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import { HistorySidebarComponent } from '../../features/history/history-sidebar.component';
import { FileIpcService } from '../services/ipc/file-ipc.service';
import { HistoryIpcService } from '../services/ipc/history-ipc.service';
import { SessionShareIpcService } from '../services/ipc/session-share-ipc.service';
import { ViewLayoutService } from '../services/view-layout.service';
import { HistoryStore } from './history.store';
import { InstanceStore } from './instance.store';
import { SideChatStore } from './side-chat.store';

function entry(id: string, hideFromProjectRail?: boolean): ConversationHistoryEntry {
  return {
    id, displayName: id, createdAt: 1, endedAt: 2, workingDirectory: '/repo',
    messageCount: 2, firstUserMessage: `Review ${id}`, lastUserMessage: 'Finished',
    status: 'completed', originalInstanceId: `runtime-${id}`, parentId: null,
    sessionId: `session-${id}`, historyThreadId: `thread-${id}`, provider: 'codex',
    ...(hideFromProjectRail === undefined ? {} : { hideFromProjectRail }),
  };
}

describe('HistoryStore displayed history', () => {
  let store: HistoryStore;
  let rows: ConversationHistoryEntry[];
  const listHistory = vi.fn();

  beforeEach(() => {
    rows = [entry('Hidden sidechat archive', true), entry('Ordinary archived session')];
    listHistory.mockReset().mockImplementation(async () => ({ success: true, data: rows }));
    TestBed.configureTestingModule({
      imports: [HistorySidebarComponent],
      providers: [
        { provide: HistoryIpcService, useValue: { listHistory } },
        { provide: InstanceStore, useValue: {} },
        { provide: SideChatStore, useValue: { attentionFor: () => null } },
        { provide: SessionShareIpcService, useValue: {} },
        { provide: FileIpcService, useValue: {} },
        { provide: ViewLayoutService, useValue: { historySidebarWidth: 360 } },
        { provide: Router, useValue: {} },
      ],
    });
    store = TestBed.inject(HistoryStore);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('keeps hidden IPC records for ownership lookup while excluding them from displayed history', async () => {
    rows.push(entry('Explicitly visible archive', false));
    await store.loadHistory();

    expect(listHistory).toHaveBeenCalledOnce();
    expect(store.entries().map(row => row.id)).toEqual(rows.map(row => row.id));
    expect(store.entries()[0].hideFromProjectRail).toBe(true);
    expect(store.filteredEntries().map(row => row.id)).toEqual(['Ordinary archived session', 'Explicitly visible archive']);
    expect(store.entryCount()).toBe(2);
    expect(store.hasEntries()).toBe(true);
  });

  it('never reveals a hidden archive through metadata search', async () => {
    await store.loadHistory();
    store.setSearchQuery('hidden sidechat');
    expect(store.filteredEntries()).toEqual([]);
    expect(store.entryCount()).toBe(1);
    expect(store.hasEntries()).toBe(true);

    store.setSearchQuery('ordinary archived');
    expect(store.filteredEntries().map(row => row.id)).toEqual(['Ordinary archived session']);
    store.clearSearch();
    expect(store.filteredEntries().map(row => row.id)).toEqual(['Ordinary archived session']);
  });

  it('reports empty displayed history when only hidden archives remain', async () => {
    rows = [rows[0]];
    await store.loadHistory();

    expect(store.entries()).toHaveLength(1);
    expect(store.filteredEntries()).toEqual([]);
    expect(store.entryCount()).toBe(0);
    expect(store.hasEntries()).toBe(false);
  });

  it('renders only ordinary archives and the matching count through the real sidebar', async () => {
    const fixture = TestBed.createComponent(HistorySidebarComponent);
    fixture.detectChanges();
    await store.loadHistory();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(Array.from(root.querySelectorAll('.history-item .display-name'), row => row.textContent?.trim()))
      .toEqual(['Ordinary archived session']);
    expect(root.querySelector('.entry-count')?.textContent?.trim()).toBe('1 conversations');

    rows = [rows[0]];
    await store.loadHistory();
    fixture.detectChanges();
    expect(root.querySelector('.history-item')).toBeNull();
    expect(root.textContent).toContain('No conversation history yet');
    expect(root.querySelector('.entry-count')?.textContent?.trim()).toBe('0 conversations');
    expect(root.querySelector('.btn-clear-all')).toBeNull();
    expect(store.entries()).toHaveLength(1);
  });
});
