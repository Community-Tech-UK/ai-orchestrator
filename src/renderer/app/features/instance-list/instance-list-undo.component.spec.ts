import { CUSTOM_ELEMENTS_SCHEMA, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NgTemplateOutlet } from '@angular/common';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrossSessionMessagingStore } from '../../core/state/instance/cross-session-messaging.store';
import { TerminateConfirmStore } from '../../shared/terminate-confirm/terminate-confirm.store';
import { InstanceListComponent } from './instance-list.component';
import { InstanceStore } from '../../core/state/instance.store';
import { HistoryStore } from '../../core/state/history.store';
import { LoopStore } from '../../core/state/loop.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { VisibleInstanceResolver } from '../../core/services/visible-instance-resolver.service';
import { RecentDirectoriesIpcService } from '../../core/services/ipc/recent-directories-ipc.service';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { HistoryIpcService } from '../../core/services/ipc/history-ipc.service';
import { ProjectRailBuilderService } from './project-rail-builder.service';
import { ProjectRailPathService } from './project-rail-path.service';
import { HistoryRailService } from './history-rail.service';
import { ToastService } from '../../core/services/toast.service';
import { ContextMenuComponent } from '../../shared/components/context-menu/context-menu.component';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import type { ProjectGroup } from './instance-list.types';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';

const template = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), './instance-list.component.html'), 'utf8');
await resolveComponentResources(() => Promise.resolve(''));
const entry = { id: 'history-1', displayName: 'Example session', sessionId: 'session-1', provider: 'claude', workingDirectory: '/example',
  endedAt: 1, isAutomation: true } as ConversationHistoryEntry;
const group: ProjectGroup = { key: 'project', path: '/example', title: 'Example', subtitle: '/example', createdAt: 1,
  sessionCount: 1, busyCount: 0, hasSelectedInstance: false, isExpanded: true, isPinned: false, hasDraft: true,
  draftUpdatedAt: null, projectStateLabel: 'History', projectStateTone: 'history', lastActivity: 1, liveItems: [],
  historyItems: [{ kind: 'history', entry, hasChildren: true, childrenCount: 1, isExpanded: false, children: [] }] };

describe('Session list Undo actions', () => {
  const restoring = signal(false);
  const archiveEntry = vi.fn(async () => true);
  const unarchiveEntry = vi.fn(async () => true);
  beforeEach(() => {
    localStorage.clear(); restoring.set(false); archiveEntry.mockClear(); unarchiveEntry.mockClear();
    TestBed.overrideComponent(InstanceListComponent, { set: { template, templateUrl: undefined,
      imports: [NgTemplateOutlet, DragDropModule, AioTooltipDirective, ContextMenuComponent], styles: [], styleUrl: undefined,
      styleUrls: [], schemas: [CUSTOM_ELEMENTS_SCHEMA] } });
    TestBed.configureTestingModule({ providers: [
      { provide: CrossSessionMessagingStore, useValue: {} },
      { provide: TerminateConfirmStore, useValue: {} },
      { provide: InstanceStore, useValue: { selectedInstanceId: signal(null), selectedInstance: signal(null),
        instances: signal([]), rootInstances: signal([]) } },
      { provide: HistoryStore, useValue: { entries: signal([entry]), previewEntryId: signal(null), loadHistory: vi.fn(), archiveEntry, unarchiveEntry } },
      { provide: LoopStore, useValue: { runningChatIds: signal(new Set()), ensureWired: vi.fn() } },
      { provide: RemoteNodeStore, useValue: { hasNodes: signal(false) } },
      { provide: NewSessionDraftService, useValue: { revision: signal(0) } },
      { provide: VisibleInstanceResolver, useValue: { setProjectGroupsSource: vi.fn(), clearProjectGroupsSource: vi.fn() } },
      { provide: RecentDirectoriesIpcService, useValue: { getDirectories: async () => [{ path: '/example' }], addDirectory: vi.fn(async () => undefined) } },
      { provide: FileIpcService, useValue: { editorGetDefault: vi.fn(async () => ({ success: false })) } }, { provide: HistoryIpcService, useValue: {} },
      { provide: ProjectRailBuilderService, useValue: { buildProjectGroups: () => [group] } },
      { provide: ProjectRailPathService, useValue: {
        getSessionProjectPath: ProjectRailPathService.prototype.getSessionProjectPath,
        getProjectKey: (path: string) => path.toLowerCase(),
      } },
      { provide: HistoryRailService, useValue: { historyDisplayLimit: 5, getVisibleHistoryItems: () => group.historyItems,
        getHistoryThreadId: HistoryRailService.prototype.getHistoryThreadId, markHistoryEntriesSeen: vi.fn(),
        isPinnedHistory: () => false, isRestoringHistory: restoring, isThreadUnread: () => true,
        getHistoryProviderVisual: () => ({ label: 'Claude', icon: 'anthropic', color: '#fff' }),
        getHistoryTitle: () => 'The complete history thread name before truncation', getHistoryPreviewTitle: () => 'The complete history thread…',
        getHistoryChangeSummary: () => ({ additions: 2, deletions: 1 }), formatHistoryTime: () => '1m',
      } },
    ] });
  });
  afterEach(() => TestBed.resetTestingModule());

  it('archives immediately from the row action and restores the thread with Undo', async () => {
    const fixture = TestBed.createComponent(InstanceListComponent); fixture.detectChanges();
    const toast = TestBed.inject(ToastService);
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('.history-entry-action')!.click(); fixture.detectChanges();
    expect(archiveEntry).toHaveBeenCalledExactlyOnceWith('history-1');
    await fixture.whenStable();
    expect(toast.toasts()).toHaveLength(1);
    expect(toast.toasts()[0]).toMatchObject({ text: 'Archived "Example session"', type: 'success',
      durationMs: 5000, action: { label: 'Undo' } });
    expect(unarchiveEntry).not.toHaveBeenCalled();
    await toast.toasts()[0].action!.run();
    expect(unarchiveEntry).toHaveBeenCalledExactlyOnceWith('history-1');
    expect(toast.toasts()[0].text).toBe('Restored: Archived "Example session"');
  });
  it('archives from the real thread context menu and restores from its Undo notice', async () => {
    const fixture = TestBed.createComponent(InstanceListComponent);
    try {
      fixture.detectChanges();
      fixture.nativeElement.querySelector('.history-entry').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      await fixture.whenStable(); fixture.detectChanges();
      const archive = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((button) => button.textContent?.trim() === 'Archive thread');
      expect(archive).toBeDefined();
      expect(archiveEntry).not.toHaveBeenCalled();
      archive!.click();
      await fixture.whenStable(); fixture.detectChanges();
      expect(archiveEntry).toHaveBeenCalledExactlyOnceWith('history-1');
      const toast = TestBed.inject(ToastService).toasts()[0];
      expect(toast).toMatchObject({ text: 'Archived "Example session"', durationMs: 5000, action: { label: 'Undo' } });
      await toast.action!.run();
      expect(unarchiveEntry).toHaveBeenCalledExactlyOnceWith('history-1');
    } finally { fixture.destroy(); }
  });
});
