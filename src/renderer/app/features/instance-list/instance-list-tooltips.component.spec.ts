import { CUSTOM_ELEMENTS_SCHEMA, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
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
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import type { ProjectGroup } from './instance-list.types';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';

const template = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), './instance-list.component.html'), 'utf8');
await resolveComponentResources(() => Promise.resolve(''));
const entry = { id: 'history-1', sessionId: 'session-1', provider: 'claude', workingDirectory: '/example',
  endedAt: 1, isAutomation: true } as ConversationHistoryEntry;
const group: ProjectGroup = { key: 'project', path: '/example', title: 'Example', subtitle: '/example', createdAt: 1,
  sessionCount: 1, busyCount: 0, hasSelectedInstance: false, isExpanded: true, isPinned: false, hasDraft: true,
  draftUpdatedAt: null, projectStateLabel: 'History', projectStateTone: 'history', lastActivity: 1, liveItems: [],
  historyItems: [{ kind: 'history', entry, hasChildren: true, childrenCount: 1, isExpanded: false, children: [] }] };

describe('Session list tooltip DOM', () => {
  const restoring = signal(false);
  const archiveEntry = vi.fn(async () => true);
  beforeEach(() => {
    localStorage.clear(); restoring.set(false); archiveEntry.mockClear();
    TestBed.overrideComponent(InstanceListComponent, { set: { template, templateUrl: undefined,
      imports: [NgTemplateOutlet, DragDropModule, AioTooltipDirective], styles: [], styleUrl: undefined,
      styleUrls: [], schemas: [CUSTOM_ELEMENTS_SCHEMA] } });
    TestBed.configureTestingModule({ providers: [
      { provide: CrossSessionMessagingStore, useValue: {} },
      { provide: TerminateConfirmStore, useValue: {} },
      { provide: InstanceStore, useValue: { selectedInstanceId: signal(null), selectedInstance: signal(null),
        instances: signal([]), rootInstances: signal([]) } },
      { provide: HistoryStore, useValue: { entries: signal([]), previewEntryId: signal(null), loadHistory: vi.fn(), archiveEntry } },
      { provide: LoopStore, useValue: { runningChatIds: signal(new Set()), ensureWired: vi.fn() } },
      { provide: RemoteNodeStore, useValue: { hasNodes: signal(false) } },
      { provide: NewSessionDraftService, useValue: { revision: signal(0) } },
      { provide: VisibleInstanceResolver, useValue: { setProjectGroupsSource: vi.fn(), clearProjectGroupsSource: vi.fn() } },
      { provide: RecentDirectoriesIpcService, useValue: { getDirectories: async () => [] } },
      { provide: FileIpcService, useValue: {} }, { provide: HistoryIpcService, useValue: {} },
      { provide: ProjectRailBuilderService, useValue: { buildProjectGroups: () => [group] } },
      { provide: ProjectRailPathService, useValue: {} },
      { provide: HistoryRailService, useValue: { historyDisplayLimit: 5, getVisibleHistoryItems: () => group.historyItems,
        isPinnedHistory: () => false, isRestoringHistory: restoring, isThreadUnread: () => true,
        getHistoryProviderVisual: () => ({ label: 'Claude', icon: 'anthropic', color: '#fff' }),
        getHistoryTitle: () => 'The complete history thread name before truncation', getHistoryPreviewTitle: () => 'The complete history thread…',
        getHistoryChangeSummary: () => ({ additions: 2, deletions: 1 }), formatHistoryTime: () => '1m',
      } },
    ] });
  });
  afterEach(() => TestBed.resetTestingModule());

  it('removes native titles, retains distinct icon names, and includes filters-on in the name and hint', () => {
    const fixture = TestBed.createComponent(InstanceListComponent); fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
    const toggle = fixture.debugElement.query(By.css('.filters-toggle'));
    expect(toggle.nativeElement.getAttribute('aria-label')).toBe('Filter and sort options');
    expect(toggle.injector.get(AioTooltipDirective).appTooltip()).toBe('Filter and sort');
    fixture.componentInstance.statusFilter.set('active'); fixture.detectChanges();
    expect(toggle.nativeElement.getAttribute('aria-label')).toBe('Filter and sort options, filters on');
    expect(toggle.injector.get(AioTooltipDirective).appTooltip()).toBe('Filter and sort, filters on');
    for (const selector of ['.project-drag-handle', '.project-action-btn', '.history-entry-pin', '.history-entry-tree-toggle', '.history-entry-action']) {
      for (const control of fixture.debugElement.queryAll(By.css(selector))) {
        expect(control.nativeElement.getAttribute('aria-label')).toBeTruthy();
        expect(control.injector.get(AioTooltipDirective)).toBeTruthy();
      }
    }
  });
  it('exposes the whole hidden-automation explanation beside its checkbox', () => {
    const fixture = TestBed.createComponent(InstanceListComponent); fixture.componentInstance.filtersOpen.set(true); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.filter-help').textContent).toBe('Hidden automations stay out of the rail while they are working normally. A run that fails, or stops for permission, is always shown.');
  });
  it('keeps restricted reorder handles focusable, styled as disabled, and guarded against activation', () => {
    const fixture = TestBed.createComponent(InstanceListComponent); fixture.componentInstance.filterInput.set('find'); fixture.detectChanges();
    const handle = fixture.debugElement.query(By.css('.project-drag-handle'));
    const element = handle.nativeElement as HTMLButtonElement;
    expect(element.disabled).toBe(false); expect(element.tabIndex).toBe(0);
    expect(element.getAttribute('aria-disabled')).toBe('true'); expect(element.classList.contains('aio-reason-disabled')).toBe(true);
    const activation = vi.fn(); element.addEventListener('click', activation);
    const matches = element.matches.bind(element);
    vi.spyOn(element, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    element.dispatchEvent(new FocusEvent('focus')); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Clear the project search to reorder projects.');
    element.click(); expect(activation).not.toHaveBeenCalled();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    fixture.componentInstance.filterInput.set(''); fixture.detectChanges(); element.click(); expect(activation).toHaveBeenCalledOnce();
  });
  it('shows state and archive consequences visibly before confirmation', () => {
    const fixture = TestBed.createComponent(InstanceListComponent); fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.project-draft-pill')?.textContent).toBe('Draft saved');
    expect(host.querySelector('.history-entry-provider-name')?.textContent).toBe('Claude');
    expect(host.querySelector('.history-entry-unread-dot')?.textContent).toContain('Completed — click to view');
    expect(host.querySelector('.history-entry-automation-clock')?.textContent).toContain('Started by a scheduled automation');
    host.querySelector<HTMLButtonElement>('.history-entry-action')!.click(); fixture.detectChanges();
    expect(archiveEntry).not.toHaveBeenCalled();
    expect(host.querySelector('.archive-warning')?.textContent).toBe('Hides this thread from the project list. The conversation is kept in Archive.');
    host.querySelector<HTMLButtonElement>('.history-entry-confirm-btn')!.click();
    expect(archiveEntry).toHaveBeenCalledWith('history-1');
  });
  it('uses the full thread name for overflow, and retains native disabled with visible progress during loading', () => {
    const fixture = TestBed.createComponent(InstanceListComponent); fixture.detectChanges();
    const title = fixture.debugElement.query(By.css('.history-entry-title'));
    expect(title.injector.get(AioTooltipDirective).appTooltipVariant()).toBe('overflow');
    expect(title.injector.get(AioTooltipDirective).appTooltip()).toBe('The complete history thread name before truncation');
    restoring.set(true); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.history-entry-main').disabled).toBe(true);
    expect(title.nativeElement.textContent).toContain('Loading…');
  });
});
