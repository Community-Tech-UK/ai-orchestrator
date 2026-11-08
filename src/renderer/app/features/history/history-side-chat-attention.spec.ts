import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { ChatEvent } from '../../../../shared/types/chat.types';
import type { SideChatAttention, SideChatParentRef } from '../../../../shared/types/side-chat.types';
import { SideChatStore } from '../../core/state/side-chat.store';
import { ChatStore } from '../../core/state/chat.store';
import { ChatIpcService } from '../../core/services/ipc/chat-ipc.service';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { LoopStore } from '../../core/state/loop.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { CrossSessionMessagingStore } from '../../core/state/instance/cross-session-messaging.store';
import { NeedsYouStore } from '../workboard/needs-you.store';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { HistoryIpcService } from '../../core/services/ipc/history-ipc.service';
import { SessionShareIpcService } from '../../core/services/ipc/session-share-ipc.service';
import { RecentDirectoriesIpcService } from '../../core/services/ipc/recent-directories-ipc.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { VisibleInstanceResolver } from '../../core/services/visible-instance-resolver.service';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { ToastService } from '../../core/services/toast.service';
import { ViewLayoutService } from '../../core/services/view-layout.service';
import { TerminateConfirmStore } from '../../shared/terminate-confirm/terminate-confirm.store';
import { ProjectRailBuilderService } from '../instance-list/project-rail-builder.service';
import { ProjectRailPathService } from '../instance-list/project-rail-path.service';
import { HistoryRailService } from '../instance-list/history-rail.service';
import { InstanceListComponent } from '../instance-list/instance-list.component';
import type { ProjectGroup } from '../instance-list/instance-list.types';
import { HistorySidebarComponent } from './history-sidebar.component';

await resolveComponentResources(async (url) => url.endsWith('instance-list.component.html')
  ? readFileSync(resolve(__dirname, '../instance-list/instance-list.component.html'), 'utf8') : '');

const parent: SideChatParentRef = { kind: 'session', historyThreadId: 'stable-thread', originNodeId: null };
const entry: ConversationHistoryEntry = {
  id: 'archive-copy', historyThreadId: 'stable-thread', originalInstanceId: 'old-runtime',
  sessionId: 'provider-native-session', workingDirectory: '/tmp/shared-project', displayName: 'Archived parent',
  createdAt: 1, endedAt: 2, messageCount: 2, firstUserMessage: 'Question', lastUserMessage: 'Question',
  status: 'completed', parentId: null,
};
const sibling = { ...entry, id: 'other-archive', historyThreadId: 'other-thread', displayName: 'Same project' };
const legacy = { ...entry, id: 'legacy-archive', historyThreadId: undefined, sessionId: 'stable-thread' };
const entries = [entry, sibling, legacy];

function attention(patch: Partial<SideChatAttention> = {}): SideChatAttention {
  return { parent, parentTitle: 'Archived parent', total: 2, unread: 1, needsAttention: 0, attentionSince: null,
    running: 0, targetChatId: 'exact-sidechat', ...patch };
}

// Run the same contract through BOTH real history presentations. Store startup
// receives persisted attention with no parent runtime and no mounted panel.
describe.each(['project rail', 'History sidebar'] as const)('%s sidechat attention', (presentation) => {
  let fixture: ComponentFixture<InstanceListComponent | HistorySidebarComponent>;
  let store: SideChatStore;
  let emit: (event: ChatEvent) => void;
  let history: { loadConversation: ReturnType<typeof vi.fn>; restoreEntry: ReturnType<typeof vi.fn> };
  let ipc: { sideChatList: ReturnType<typeof vi.fn>; sideChatSend: ReturnType<typeof vi.fn> };
  const closed = vi.fn();

  beforeEach(async () => {
    closed.mockClear();
    history = { loadConversation: vi.fn(), restoreEntry: vi.fn() };
    ipc = {
      sideChatList: vi.fn().mockResolvedValue({ success: true, data: { active: [], archived: [] } }),
      sideChatSend: vi.fn(),
    };
    const group: ProjectGroup = {
      key: 'project', path: null, title: 'Project', subtitle: '', createdAt: 1, sessionCount: 3, busyCount: 0,
      hasSelectedInstance: false, isExpanded: true, isPinned: false, hasDraft: false, draftUpdatedAt: null,
      projectStateLabel: '', projectStateTone: 'history', lastActivity: 2, liveItems: [],
      historyItems: entries.map((entry) => ({ kind: 'history', entry, hasChildren: false,
        childrenCount: 0, isExpanded: false, children: [] })),
    };
    await TestBed.configureTestingModule({
      providers: [
        { provide: ChatIpcService, useValue: { ...ipc,
          onChatEvent: (callback: typeof emit) => { emit = callback; return vi.fn(); },
          sideChatAttentionAll: vi.fn().mockResolvedValue({ success: true, data: [attention()] }),
          sideChatPermissions: vi.fn().mockResolvedValue({ success: true }),
        } },
        { provide: ChatStore, useValue: { ensureDetailLoaded: vi.fn() } },
        { provide: HistoryStore, useValue: { ...history, loadHistory: vi.fn(), entries: signal(entries),
          filteredEntries: signal(entries), previewEntryId: signal(null), searchQuery: signal(''),
          loading: signal(false), entryCount: signal(entries.length), hasEntries: signal(true) } },
        { provide: InstanceStore, useValue: { selectedInstanceId: signal(null), selectedInstance: signal(null),
          instances: signal([]), rootInstances: signal([]), listLoadFailure: signal(null) } },
        { provide: LoopStore, useValue: { runningChatIds: signal(new Set()), ensureWired: vi.fn() } },
        { provide: RemoteNodeStore, useValue: { hasNodes: signal(false) } },
        { provide: TerminateConfirmStore, useValue: {} },
        { provide: FileIpcService, useValue: {} },
        { provide: NeedsYouStore, useValue: { sessionIds: () => new Set<string>(), entries: () => [], reasonBySession: () => new Map<string, string>() } },
        { provide: HistoryIpcService, useValue: {} },
        { provide: SessionShareIpcService, useValue: {} },
        { provide: RecentDirectoriesIpcService, useValue: { getDirectories: vi.fn().mockResolvedValue([]) } },
        { provide: NewSessionDraftService, useValue: { revision: signal(0) } },
        { provide: ProjectRailBuilderService, useValue: { buildProjectGroups: () => [group] } },
        { provide: ProjectRailPathService, useValue: { getSessionProjectPath: () => null } },
        { provide: VisibleInstanceResolver, useValue: { setProjectGroupsSource: vi.fn(), clearProjectGroupsSource: vi.fn() } },
        { provide: CrossSessionMessagingStore, useValue: {} },
        { provide: CLIPBOARD_SERVICE, useValue: {} },
        { provide: ToastService, useValue: {} },
        { provide: ViewLayoutService, useValue: { historySidebarWidth: 360 } },
        { provide: Router, useValue: {} },
        { provide: HistoryRailService, useValue: {
          getVisibleHistoryItems: () => group.historyItems, markHistoryEntriesSeen: vi.fn(),
          getHistoryThreadId: (entry: ConversationHistoryEntry) => entry.historyThreadId ?? entry.id,
          isPinnedHistory: () => false, isRestoringHistory: () => false, isThreadUnread: () => false,
          getHistoryTitle: (entry: ConversationHistoryEntry) => entry.displayName,
          getHistoryPreviewTitle: (entry: ConversationHistoryEntry) => entry.displayName,
          getHistoryProviderVisual: () => ({ icon: 'generic', color: '', label: 'Session' }),
          getHistoryChangeSummary: () => null, formatHistoryTime: () => '',
        } },
      ],
    }).compileComponents();
    store = TestBed.inject(SideChatStore);
    await store.initialize();
    fixture = presentation === 'project rail'
      ? TestBed.createComponent(InstanceListComponent) : TestBed.createComponent(HistorySidebarComponent);
    if (fixture.componentInstance instanceof HistorySidebarComponent) {
      fixture.componentInstance.closeHistory.subscribe(closed);
    }
    fixture.detectChanges();
  });

  afterEach(() => { fixture?.destroy(); store?.disposeForTesting(); });

  function badge(): HTMLButtonElement {
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.side-chat-badge');
    expect(button, 'persisted unread sidechat must be visible on its archived parent').not.toBeNull();
    return button!;
  }

  it('shows persisted unread only on its stable thread, not a shared project or native session id', () => {
    expect(badge().dataset['kind']).toBe('unread');
    expect(badge().getAttribute('aria-label')).toBe('1 unread sidechat answer, open sidechats');
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.side-chat-badge')).toHaveLength(1);
    expect(ipc.sideChatList).not.toHaveBeenCalled();
  });

  it('updates priority and counts when attention arrives without loading parent or sidechat transcripts', () => {
    for (const [patch, kind, label] of [
      [{ needsAttention: 1, unread: 1, running: 1 }, 'needs-attention', '1 sidechat needs action'],
      [{ unread: 2, running: 1 }, 'unread', '2 unread sidechat answers'],
      [{ unread: 0, running: 1 }, 'running', '1 sidechat running'],
      [{ unread: 0 }, 'quiet', '2 sidechats'],
    ] as const) {
      emit({ type: 'side-chat-attention', attention: attention(patch) });
      fixture.detectChanges();
      expect(badge().dataset['kind']).toBe(kind);
      expect(badge().textContent?.trim()).toBe(label);
    }
    expect(history.loadConversation).not.toHaveBeenCalled();
    expect(ipc.sideChatList).not.toHaveBeenCalled();
    emit({ type: 'side-chat-attention', attention: attention({ total: 0, unread: 0 }) });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.side-chat-badge')).toBeNull();
  });

  it('requests the exact sidechat without expanding, previewing, restoring or sending to its parent', () => {
    // Native button activation follows these key events. The surrounding
    // history header must not also interpret them as an expand action.
    badge().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    badge().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    badge().click();
    expect(store.openRequest()).toMatchObject({ parent, chatId: 'exact-sidechat' });
    expect(history.loadConversation).not.toHaveBeenCalled();
    expect(history.restoreEntry).not.toHaveBeenCalled();
    expect(ipc.sideChatSend).not.toHaveBeenCalled();
    if (presentation === 'History sidebar') expect(closed).toHaveBeenCalledOnce();
  });

  it('provides the accessible state as a real hover tooltip', async () => {
    badge().dispatchEvent(new MouseEvent('mouseenter'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent?.trim())
      .toBe(badge().getAttribute('aria-label'));
    expect(badge().hasAttribute('title')).toBe(false);
  });

  it('opens the parent selector immediately for quiet sidechats without fetching or restoring the parent', async () => {
    emit({ type: 'side-chat-attention', attention: attention({ unread: 0, targetChatId: null }) });
    fixture.detectChanges();

    badge().click();
    await fixture.whenStable();

    expect(store.openRequest()).toMatchObject({ parent, chatId: null });
    expect(ipc.sideChatList).not.toHaveBeenCalled();
    expect(history.restoreEntry).not.toHaveBeenCalled();
    expect(history.loadConversation).not.toHaveBeenCalled();
    expect(ipc.sideChatSend).not.toHaveBeenCalled();
    if (presentation === 'History sidebar') expect(closed).toHaveBeenCalledOnce();
  });
});
