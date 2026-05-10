/**
 * Instance List Component - Project-grouped session rail
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { InstanceStore, type Instance } from '../../core/state/instance.store';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import { HistoryStore } from '../../core/state/history.store';
import { LoopStore } from '../../core/state/loop.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { RecentDirectoriesIpcService } from '../../core/services/ipc/recent-directories-ipc.service';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { HistoryIpcService } from '../../core/services/ipc/history-ipc.service';
import { InstanceRowComponent } from './instance-row.component';
import { ContextMenuComponent, type ContextMenuItem } from '../../shared/components/context-menu/context-menu.component';
import { resolveEffectiveInstanceTitle } from '../../../../shared/types/history.types';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { RecentDirectoryEntry } from '../../../../shared/types/recent-directories.types';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { ProjectGroupComputationService } from './project-group-computation.service';
import { HistoryRailService } from './history-rail.service';
import {
  getHistoryTimeWindowCutoff,
  type HistoryTimeWindow,
  type HistoryVisibilityMode,
  isNativeImportedHistoryEntry,
  shouldShowHistoryOnlyProject,
} from './history-rail-filtering';
import { VisibleInstanceResolver } from '../../core/services/visible-instance-resolver.service';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';

const ORDER_STORAGE_KEY = 'instance-list-order';
const SORT_MODE_STORAGE_KEY = 'instance-list-sort-mode';
const HISTORY_VISIBILITY_STORAGE_KEY = 'instance-list-history-visibility';
const HISTORY_TIME_WINDOW_STORAGE_KEY = 'instance-list-history-time-window';
const NO_WORKSPACE_KEY = '__no_workspace__';
type HistorySortMode = 'last-interacted' | 'created';

export interface HierarchicalInstance {
  instance: Instance;
  railTitle: string;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isLastChild: boolean;
  parentChain: boolean[];
}

interface ProjectGroup {
  key: string;
  path: string | null;
  title: string;
  subtitle: string;
  createdAt: number;
  sessionCount: number;
  busyCount: number;
  hasSelectedInstance: boolean;
  isExpanded: boolean;
  isPinned: boolean;
  hasDraft: boolean;
  draftUpdatedAt: number | null;
  projectStateLabel: string;
  projectStateTone: 'working' | 'attention' | 'connecting' | 'ready' | 'history';
  lastActivity: number;
  liveItems: HierarchicalInstance[];
  historyItems: ConversationHistoryEntry[];
}

interface ProjectPathGroupIndex {
  group: ProjectGroup;
  index: number;
}

interface RailChangeSummary {
  additions: number;
  deletions: number;
}

@Component({
  selector: 'app-instance-list',
  standalone: true,
  imports: [ScrollingModule, InstanceRowComponent, DragDropModule, ContextMenuComponent],
  templateUrl: './instance-list.component.html',
  styleUrl: './instance-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InstanceListComponent implements OnDestroy {
  private static readonly MIN_VISIBLE_HISTORY_THREADS = 5;

  private host = inject(ElementRef<HTMLElement>);
  private store = inject(InstanceStore);
  private historyStore = inject(HistoryStore);
  private loopStore = inject(LoopStore);
  private recentDirectoriesService = inject(RecentDirectoriesIpcService);
  private fileIpc = inject(FileIpcService);
  private historyIpc = inject(HistoryIpcService);
  protected readonly remoteNodeStore = inject(RemoteNodeStore);
  protected readonly projectGroupComputation = inject(ProjectGroupComputationService);
  protected readonly historyRail = inject(HistoryRailService);
  private newSessionDraft = inject(NewSessionDraftService);
  private visibleInstanceResolver = inject(VisibleInstanceResolver);
  private clipboard = inject(CLIPBOARD_SERVICE);

  filterInput = signal('');
  filterText = signal('');
  statusFilter = signal<string>('all');
  locationFilter = signal<'all' | 'local' | 'remote'>('all');
  filtersOpen = signal(false);
  pendingArchiveId = signal<string | null>(null);
  collapsedIds = signal<Set<string>>(new Set());
  collapsedProjectKeys = signal<Set<string>>(new Set());
  rootInstanceOrder = signal<string[]>(this.loadOrder());
  recentDirectories = signal<RecentDirectoryEntry[]>([]);
  historySortMode = signal<HistorySortMode>(this.loadSortMode());
  historyVisibilityMode = signal<HistoryVisibilityMode>(this.loadHistoryVisibilityMode());
  historyTimeWindow = signal<HistoryTimeWindow>(this.loadHistoryTimeWindow());
  openProjectMenuKey = signal<string | null>(null);
  preferredEditorLabel = signal('Editor');
  lastVisitedHistoryThreadId = signal<string | null>(null);
  protected contextMenuVisible = signal(false);
  protected contextMenuX = signal(0);
  protected contextMenuY = signal(0);
  protected contextMenuItems = signal<ContextMenuItem[]>([]);
  selectedId = this.store.selectedInstanceId;
  /**
   * Set of instance ids that currently have a non-terminal Loop Mode run.
   * Each row reads `loopingInstanceIds().has(item.instance.id)` from the
   * template — one Set lookup per row, no extra computeds allocated.
   *
   * NOTE: chats started from `chat-detail` are keyed by chat id, while
   * chats started from `instance-detail` are keyed by instance id. The
   * project rail surfaces instances, so only the latter naturally line up;
   * that's the right behaviour here — a loop attached to a free-standing
   * chat record (no live instance) has no row to decorate.
   */
  loopingInstanceIds = this.loopStore.runningChatIds;
  hasActiveFilters = computed(() =>
    this.statusFilter() !== 'all'
      || this.locationFilter() !== 'all'
      || this.historySortMode() !== 'last-interacted'
      || this.historyVisibilityMode() !== 'relevant'
      || this.historyTimeWindow() !== 'all'
  );
  readonly systemFileManagerLabel = this.getSystemFileManagerLabel();
  private projectMenuTrigger: HTMLButtonElement | null = null;
  private restoreSelectionRequestId = 0;
  private filterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly FILTER_DEBOUNCE_MS = 250;

  isDragDisabled = computed(() =>
    this.filterInput().length > 0 ||
      this.statusFilter() !== 'all' ||
      this.locationFilter() !== 'all'
  );
  isProjectDragDisabled = computed(() =>
    this.filterInput().length > 0 ||
      this.statusFilter() !== 'all' ||
      this.locationFilter() !== 'all' ||
      this.openProjectMenuKey() !== null
  );

  projectGroups = computed(() => {
    this.newSessionDraft.revision();
    const instances = this.store.instances();
    const historyEntries = this.historyStore.entries();
    const recentDirectories = this.recentDirectories();
    const filter = this.filterText().trim().toLowerCase();
    const status = this.statusFilter();
    const location = this.locationFilter();
    const historyVisibility = this.historyVisibilityMode();
    const activityCutoff = getHistoryTimeWindowCutoff(this.historyTimeWindow());
    const childrenByParent = this.projectGroupComputation.buildChildrenMap(instances);
    const instanceMap = new Map(instances.map((instance) => [instance.id, instance]));
    const selectedId = this.selectedId();
    const collapsed = this.collapsedIds();
    const collapsedProjects = this.collapsedProjectKeys();
    const historyByProject = this.buildHistoryEntriesByProject(
      historyEntries,
      filter,
      status,
      location,
      activityCutoff
    );
    const recentDirectoriesByKey = new Map(
      recentDirectories.map((entry) => [this.getProjectKey(entry.path), entry])
    );
    const recentDirectoryOrder = new Map(
      recentDirectories.map((entry, index) => [this.getProjectKey(entry.path), index] as const)
    );
    const groups = new Map<string, ProjectGroup>();

    for (const root of this.getOrderedRootInstances(instances)) {
      const projectKey = this.getProjectKey(root.workingDirectory);
      const title = this.getProjectTitle(root.workingDirectory);
      const subtitle = this.getProjectSubtitle(root.workingDirectory);
      const projectMatches = !!filter && this.projectGroupComputation.matchesProjectText(title, subtitle, filter);
      const rawHistoryItems = historyByProject.get(projectKey) ?? [];
      const existingGroup = groups.get(projectKey);
      const historyLookupItems = existingGroup?.historyItems ?? rawHistoryItems;
      const historyByThreadId = new Map(
        historyLookupItems.map((entry) => [this.historyRail.getHistoryThreadId(entry), entry])
      );
      const liveItems = this.projectGroupComputation.buildVisibleItems(
        root,
        {
          filter,
          status,
          location,
          projectMatches,
          collapsed,
          childrenByParent,
          instanceMap,
          activityCutoff,
        },
        0,
        [],
        true
      ).map((item) => ({
        ...item,
        railTitle: this.getLiveRailTitle(
          item.instance,
          historyByThreadId.get(this.getInstanceThreadId(item.instance))
        ),
      }));
      const liveThreadIds = new Set(
        liveItems
          .map((item) => this.getInstanceThreadId(item.instance))
          .filter((threadId): threadId is string => threadId.trim().length > 0)
      );
      const historySourceItems = existingGroup?.historyItems ?? rawHistoryItems;
      const historyItems = historySourceItems.filter(
        (entry) => !liveThreadIds.has(this.historyRail.getHistoryThreadId(entry))
      );

      if (liveItems.length === 0 && historyItems.length === 0) {
        continue;
      }

      const recentDirectory = recentDirectoriesByKey.get(projectKey);
      const draftInfo = this.projectGroupComputation.getProjectDraftInfo(root.workingDirectory);
      const group = existingGroup ?? {
        key: projectKey,
        path: root.workingDirectory?.trim() || null,
        title: recentDirectory?.displayName || title,
        subtitle: recentDirectory ? this.getProjectSubtitle(recentDirectory.path) : subtitle,
        createdAt: recentDirectory?.lastAccessed ?? root.createdAt,
        sessionCount: 0,
        busyCount: 0,
        hasSelectedInstance: false,
        isExpanded: !collapsedProjects.has(projectKey),
        isPinned: recentDirectory?.isPinned ?? false,
        hasDraft: draftInfo.hasDraft,
        draftUpdatedAt: draftInfo.draftUpdatedAt,
        projectStateLabel: 'Ready',
        projectStateTone: 'ready',
        lastActivity: recentDirectory?.lastAccessed ?? root.lastActivity ?? root.createdAt,
        liveItems: [],
        historyItems: [],
      };
      const previousHistoryCount = group.historyItems.length;

      group.liveItems.push(...liveItems);
      group.createdAt = Math.max(
        group.createdAt,
        root.createdAt,
        ...rawHistoryItems.map((item) => item.createdAt)
      );
      group.sessionCount += this.projectGroupComputation.countSessionsInTree(root, childrenByParent, instanceMap);
      group.busyCount += this.projectGroupComputation.countBusySessions(root, childrenByParent, instanceMap);
      group.hasSelectedInstance = group.hasSelectedInstance || liveItems.some((item) => item.instance.id === selectedId);
      group.isExpanded = !collapsedProjects.has(projectKey);
      group.historyItems = historyItems;
      group.hasDraft = group.hasDraft || draftInfo.hasDraft;
      group.draftUpdatedAt = group.draftUpdatedAt ?? draftInfo.draftUpdatedAt;
      Object.assign(group, this.projectGroupComputation.getProjectStateSummary(group.liveItems, group.historyItems, group.hasDraft));
      group.sessionCount += historyItems.length - previousHistoryCount;
      groups.set(projectKey, group);
      historyByProject.delete(projectKey);
      recentDirectoriesByKey.delete(projectKey);
    }

    for (const [projectKey, historyItems] of historyByProject) {
      if (historyItems.length === 0) {
        continue;
      }

      const recentDirectory = recentDirectoriesByKey.get(projectKey);
      const workingDirectory = recentDirectory?.path || historyItems[0].workingDirectory || null;
      const draftInfo = this.projectGroupComputation.getProjectDraftInfo(workingDirectory);
      if (!shouldShowHistoryOnlyProject({
        mode: historyVisibility,
        hasTextFilter: filter.length > 0,
        hasDraft: draftInfo.hasDraft,
        isPinnedProject: recentDirectory?.isPinned ?? false,
        selectedHistoryEntryId: this.historyStore.previewEntryId(),
        pinnedHistoryIds: this.historyRail.pinnedHistoryIds(),
        historyItems,
      })) {
        recentDirectoriesByKey.delete(projectKey);
        continue;
      }

      groups.set(projectKey, {
        key: projectKey,
        path: workingDirectory,
        title: recentDirectory?.displayName || this.getProjectTitle(historyItems[0].workingDirectory),
        subtitle: recentDirectory ? this.getProjectSubtitle(recentDirectory.path) : this.getProjectSubtitle(historyItems[0].workingDirectory),
        createdAt: Math.max(
          recentDirectory?.lastAccessed ?? 0,
          ...historyItems.map((item) => item.createdAt)
        ),
        sessionCount: historyItems.length,
        busyCount: 0,
        hasSelectedInstance: false,
        isExpanded: !collapsedProjects.has(projectKey),
        isPinned: recentDirectory?.isPinned ?? false,
        hasDraft: draftInfo.hasDraft,
        draftUpdatedAt: draftInfo.draftUpdatedAt,
        ...this.projectGroupComputation.getProjectStateSummary([], historyItems, draftInfo.hasDraft),
        lastActivity: recentDirectory?.lastAccessed ?? historyItems[0].endedAt,
        liveItems: [],
        historyItems,
      });
      recentDirectoriesByKey.delete(projectKey);
    }

    if (status === 'all' && location !== 'remote') {
      for (const recentDirectory of recentDirectoriesByKey.values()) {
        const title = recentDirectory.displayName || this.getProjectTitle(recentDirectory.path);
        const subtitle = this.getProjectSubtitle(recentDirectory.path);
        if (filter && !this.projectGroupComputation.matchesProjectText(title, subtitle, filter)) {
          continue;
        }

        const projectKey = this.getProjectKey(recentDirectory.path);
        const draftInfo = this.projectGroupComputation.getProjectDraftInfo(recentDirectory.path);
        const recentActivity = Math.max(
          recentDirectory.lastAccessed,
          draftInfo.draftUpdatedAt ?? 0
        );
        if (activityCutoff !== null && recentActivity < activityCutoff) {
          continue;
        }

        groups.set(projectKey, {
          key: projectKey,
          path: recentDirectory.path || null,
          title,
          subtitle,
          createdAt: recentDirectory.lastAccessed,
          sessionCount: 0,
          busyCount: 0,
          hasSelectedInstance: false,
          isExpanded: !collapsedProjects.has(projectKey),
          isPinned: recentDirectory.isPinned,
          hasDraft: draftInfo.hasDraft,
          draftUpdatedAt: draftInfo.draftUpdatedAt,
          ...this.projectGroupComputation.getProjectStateSummary([], [], draftInfo.hasDraft),
          lastActivity: recentDirectory.lastAccessed,
          liveItems: [],
          historyItems: [],
        });
      }
    }

    return Array.from(groups.values()).sort((left, right) => {
      const leftOrder = recentDirectoryOrder.get(left.key);
      const rightOrder = recentDirectoryOrder.get(right.key);
      if (leftOrder !== undefined && rightOrder !== undefined) {
        return leftOrder - rightOrder;
      }
      if (leftOrder !== undefined) {
        return -1;
      }
      if (rightOrder !== undefined) {
        return 1;
      }

      const timestampDelta =
        this.getProjectSortTimestamp(right) - this.getProjectSortTimestamp(left);
      if (timestampDelta !== 0) {
        return timestampDelta;
      }

      return left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
    });
  });

  constructor() {
    this.visibleInstanceResolver.setProjectGroupsSource(this.projectGroups);
    void this.historyStore.loadHistory();
    void this.loadRecentDirectories();
    // Subscribe to loop IPC events so the rail can show the loop spinner
    // for sessions that aren't currently selected. ensureWired is
    // idempotent — safe to call from multiple components.
    this.loopStore.ensureWired();

    effect(() => {
      const selected = this.store.selectedInstance();
      if (!selected) {
        return;
      }

      this.lastVisitedHistoryThreadId.set(this.getInstanceThreadId(selected));

      const projectKey = this.getProjectKey(selected.workingDirectory);
      this.collapsedProjectKeys.update((current) => {
        if (!current.has(projectKey)) {
          return current;
        }

        const next = new Set(current);
        next.delete(projectKey);
        return next;
      });

      this.collapsedIds.update((current) => {
        let changed = false;
        const next = new Set(current);
        let parentId = selected.parentId;

        while (parentId) {
          if (next.delete(parentId)) {
            changed = true;
          }
          parentId = this.store.instancesMap().get(parentId)?.parentId ?? null;
        }

        return changed ? next : current;
      });
    });

    let previousRootIds = new Set<string>();
    effect(() => {
      const currentRootIds = new Set(this.store.rootInstances().map((instance) => instance.id));
      const removedRoot = previousRootIds.size > 0 &&
        Array.from(previousRootIds).some((id) => !currentRootIds.has(id));
      const historyEntries = this.historyStore.entries();
      const knownRecentDirectories = new Set(
        untracked(() => this.recentDirectories()).map((entry) => this.getProjectKey(entry.path))
      );
      const missingDirectories: { path: string; nodeId?: string }[] = [];

      previousRootIds = currentRootIds;

      // Sync live workspaces into the persisted recent-project index.
      for (const instance of this.store.rootInstances()) {
        const workingDirectory = instance.workingDirectory?.trim();
        if (workingDirectory && !knownRecentDirectories.has(this.getProjectKey(workingDirectory))) {
          knownRecentDirectories.add(this.getProjectKey(workingDirectory));
          const loc = instance.executionLocation;
          missingDirectories.push({
            path: workingDirectory,
            ...(loc?.type === 'remote' ? { nodeId: loc.nodeId } : {}),
          });
        }
      }
      for (const entry of historyEntries) {
        if (isNativeImportedHistoryEntry(entry)) {
          continue;
        }

        const workingDirectory = entry.workingDirectory?.trim();
        if (workingDirectory && !knownRecentDirectories.has(this.getProjectKey(workingDirectory))) {
          knownRecentDirectories.add(this.getProjectKey(workingDirectory));
          missingDirectories.push({
            path: workingDirectory,
            ...(entry.executionLocation?.type === 'remote'
              ? { nodeId: entry.executionLocation.nodeId }
              : {}),
          });
        }
      }
      if (missingDirectories.length > 0) {
        void this.syncRecentDirectories(missingDirectories);
      }

      if (removedRoot) {
        void this.historyStore.loadHistory();
      }
    });

    effect(() => {
      const historyEntries = this.historyStore.entries();
      if (historyEntries.length === 0) {
        return;
      }

      const liveThreadIds = new Set(
        this.store.instances()
          .map((instance) => this.getInstanceThreadId(instance))
          .filter((threadId): threadId is string => threadId.trim().length > 0)
      );
      const latestHistoryEntries = this.getLatestHistoryEntriesByThread(historyEntries);
      const lastVisitedThreadId = this.lastVisitedHistoryThreadId();
      const seenEntries = Array.from(latestHistoryEntries.values()).filter((entry) => {
        const threadId = this.historyRail.getHistoryThreadId(entry);
        return liveThreadIds.has(threadId) || threadId === lastVisitedThreadId;
      });

      this.historyRail.markHistoryEntriesSeen(seenEntries);
    });
  }

  onFilterChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.setFilterText(input.value);
    this.closeProjectMenu({ restoreFocus: false });
  }

  setFilterText(value: string): void {
    this.filterInput.set(value);
    if (this.filterDebounceTimer) {
      clearTimeout(this.filterDebounceTimer);
    }
    this.filterDebounceTimer = setTimeout(() => {
      this.filterDebounceTimer = null;
      this.filterText.set(value);
    }, InstanceListComponent.FILTER_DEBOUNCE_MS);
  }

  ngOnDestroy(): void {
    if (this.filterDebounceTimer) {
      clearTimeout(this.filterDebounceTimer);
      this.filterDebounceTimer = null;
    }
    this.visibleInstanceResolver.clearProjectGroupsSource(this.projectGroups);
  }

  onStatusFilterChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.statusFilter.set(select.value);
    this.closeProjectMenu({ restoreFocus: false });
  }

  onLocationFilterChange(event: Event): void {
    this.locationFilter.set((event.target as HTMLSelectElement).value as 'all' | 'local' | 'remote');
  }

  onSortModeChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = select.value === 'created' ? 'created' : 'last-interacted';
    this.historySortMode.set(value);
    this.saveSortMode(value);
    this.closeProjectMenu({ restoreFocus: false });
  }

  onHistoryVisibilityModeChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value: HistoryVisibilityMode = select.value === 'all' ? 'all' : 'relevant';
    this.historyVisibilityMode.set(value);
    this.saveHistoryVisibilityMode(value);
    this.closeProjectMenu({ restoreFocus: false });
  }

  onHistoryTimeWindowChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = this.parseHistoryTimeWindow(select.value);
    this.historyTimeWindow.set(value);
    this.saveHistoryTimeWindow(value);
    this.closeProjectMenu({ restoreFocus: false });
  }

  onSelectInstance(instanceId: string): void {
    this.closeProjectMenu({ restoreFocus: false });
    this.historyStore.clearSelection();
    this.store.setSelectedInstance(instanceId);
  }

  onTerminateInstance(instanceId: string): void {
    this.store.terminateInstance(instanceId);
  }

  onRestartInstance(instanceId: string): void {
    this.store.restartInstance(instanceId);
  }

  onToggleExpand(instanceId: string): void {
    this.collapsedIds.update((current) => {
      const next = new Set(current);
      if (next.has(instanceId)) {
        next.delete(instanceId);
      } else {
        next.add(instanceId);
      }
      return next;
    });
  }

  async onInstanceContextMenu(payload: {
    event: MouseEvent;
    instance: Instance;
    displayTitle: string;
  }): Promise<void> {
    this.closeProjectMenu({ restoreFocus: false });
    this.pendingArchiveId.set(null);
    this.store.setSelectedInstance(payload.instance.id);
    await this.ensurePreferredEditorLoaded();
    this.showContextMenu(payload.event, this.buildLiveInstanceContextMenuItems(
      payload.instance,
      payload.displayTitle
    ));
  }

  async onHistoryContextMenu(event: MouseEvent, entry: ConversationHistoryEntry): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.closeProjectMenu({ restoreFocus: false });
    this.pendingArchiveId.set(null);
    await this.ensurePreferredEditorLoaded();
    this.showContextMenu(event, this.buildHistoryContextMenuItems(entry));
  }

  protected closeContextMenu(): void {
    this.contextMenuVisible.set(false);
    this.contextMenuItems.set([]);
  }

  private showContextMenu(event: MouseEvent, items: ContextMenuItem[]): void {
    if (items.length === 0) {
      this.closeContextMenu();
      return;
    }

    this.contextMenuX.set(event.clientX);
    this.contextMenuY.set(event.clientY);
    this.contextMenuItems.set(items);
    this.contextMenuVisible.set(true);
  }

  private buildLiveInstanceContextMenuItems(
    instance: Instance,
    displayTitle: string
  ): ContextMenuItem[] {
    const workingDirectory = instance.workingDirectory.trim();
    const canOpenWorkingDirectory = workingDirectory.length > 0 && instance.executionLocation?.type !== 'remote';
    const hasChildren = instance.childrenIds.length > 0;
    const isCollapsed = this.collapsedIds().has(instance.id);
    const supportsResume = instance.provider === 'claude' || instance.provider === 'codex';

    const items: ContextMenuItem[] = [
      {
        id: 'select-session',
        label: 'Select session',
        disabled: this.selectedId() === instance.id,
        action: () => this.store.setSelectedInstance(instance.id),
      },
      {
        id: 'rename-session',
        label: 'Rename session',
        action: () => void this.renameLiveInstance(instance, displayTitle),
      },
      {
        id: 'restart-session',
        label: supportsResume ? 'Restart and resume' : 'Restart session',
        disabled: instance.status === 'initializing',
        action: () => void this.store.restartInstance(instance.id),
      },
    ];

    if (hasChildren) {
      items.push({
        id: 'toggle-children',
        label: isCollapsed ? 'Expand children' : 'Collapse children',
        action: () => this.onToggleExpand(instance.id),
      });
    }

    items.push(
      {
        id: 'copy-transcript',
        label: 'Copy transcript as Markdown',
        divider: true,
        action: () => void this.copyLiveTranscript(instance.id),
      },
      {
        id: 'copy-session-id',
        label: 'Copy session ID',
        action: () => void this.copyTextToClipboard(instance.sessionId),
      }
    );

    const threadId = this.getInstanceThreadId(instance);
    if (threadId && threadId !== instance.sessionId) {
      items.push({
        id: 'copy-thread-id',
        label: 'Copy thread ID',
        action: () => void this.copyTextToClipboard(threadId),
      });
    }

    if (workingDirectory) {
      items.push({
        id: 'copy-working-directory',
        label: 'Copy working directory',
        action: () => void this.copyTextToClipboard(workingDirectory),
      });
    }

    if (canOpenWorkingDirectory) {
      items.push(
        {
          id: 'open-finder',
          label: `Open in ${this.systemFileManagerLabel}`,
          divider: true,
          action: () => void this.fileIpc.openPath(workingDirectory),
        },
        {
          id: 'open-editor',
          label: `Open in ${this.preferredEditorLabel()}`,
          action: () => void this.fileIpc.editorOpenDirectory(workingDirectory),
        }
      );
    }

    items.push({
      id: 'terminate-session',
      label: 'Terminate session',
      divider: true,
      danger: true,
      action: () => void this.store.terminateInstance(instance.id),
    });

    return items;
  }

  private buildHistoryContextMenuItems(entry: ConversationHistoryEntry): ContextMenuItem[] {
    const workingDirectory = entry.workingDirectory.trim();
    const canOpenWorkingDirectory = workingDirectory.length > 0 && entry.executionLocation?.type !== 'remote';
    const threadId = this.historyRail.getHistoryThreadId(entry);
    const isPinned = this.isPinnedHistory(entry.id);
    const isRestoring = this.isRestoringHistory(entry.id);

    const items: ContextMenuItem[] = [
      {
        id: 'restore-thread',
        label: 'Restore thread',
        disabled: isRestoring,
        action: () => void this.onRestoreHistory(entry.id),
      },
      {
        id: 'pin-thread',
        label: isPinned ? 'Unpin thread' : 'Pin thread',
        action: () => this.historyRail.togglePinnedHistoryId(entry.id),
      },
      {
        id: 'copy-thread-id',
        label: 'Copy thread ID',
        divider: true,
        action: () => void this.copyTextToClipboard(threadId),
      },
      {
        id: 'copy-session-id',
        label: 'Copy session ID',
        action: () => void this.copyTextToClipboard(entry.sessionId),
      },
    ];

    if (workingDirectory) {
      items.push({
        id: 'copy-working-directory',
        label: 'Copy working directory',
        action: () => void this.copyTextToClipboard(workingDirectory),
      });
    }

    if (canOpenWorkingDirectory) {
      items.push(
        {
          id: 'open-finder',
          label: `Open in ${this.systemFileManagerLabel}`,
          divider: true,
          action: () => void this.fileIpc.openPath(workingDirectory),
        },
        {
          id: 'open-editor',
          label: `Open in ${this.preferredEditorLabel()}`,
          action: () => void this.fileIpc.editorOpenDirectory(workingDirectory),
        }
      );
    }

    items.push({
      id: 'archive-thread',
      label: 'Archive thread',
      divider: true,
      danger: true,
      action: () => void this.historyStore.archiveEntry(entry.id),
    });

    return items;
  }

  private async renameLiveInstance(instance: Instance, displayTitle: string): Promise<void> {
    const nextName = window.prompt('Rename session', displayTitle)?.trim();
    if (!nextName || nextName === displayTitle) {
      return;
    }

    await this.store.renameInstance(instance.id, nextName);
  }

  private async copyLiveTranscript(instanceId: string): Promise<void> {
    const response = await this.historyIpc.copySessionToClipboard(instanceId, 'markdown');
    if (!response.success) {
      console.error('Failed to copy transcript:', response.error?.message ?? 'Unknown error');
    }
  }

  private async copyTextToClipboard(text: string): Promise<void> {
    if (!text.trim()) {
      return;
    }

    const result = await this.clipboard.copyText(text, { label: 'session value' });
    if (!result.ok) {
      console.error('Failed to copy to clipboard:', result.reason, result.cause);
    }
  }

  toggleProjectGroup(projectKey: string): void {
    this.closeProjectMenu({ restoreFocus: false });
    this.collapsedProjectKeys.update((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  }

  async toggleProjectPinned(group: ProjectGroup, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!group.path) {
      return;
    }

    const nextPinnedState = !group.isPinned;
    let updated = await this.recentDirectoriesService.pinDirectory(group.path, nextPinnedState);
    if (!updated) {
      await this.recentDirectoriesService.addDirectory(group.path);
      updated = await this.recentDirectoriesService.pinDirectory(group.path, nextPinnedState);
    }
    if (updated) {
      await this.loadRecentDirectories();
    }
    this.closeProjectMenu();
  }

  async toggleProjectMenu(projectKey: string, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.projectMenuTrigger = event.currentTarget instanceof HTMLButtonElement
      ? event.currentTarget
      : null;

    if (this.openProjectMenuKey() === projectKey) {
      this.closeProjectMenu();
      return;
    }

    await this.ensurePreferredEditorLoaded();
    this.openProjectMenuKey.set(projectKey);
    requestAnimationFrame(() => {
      const firstMenuItem = this.host.nativeElement.querySelector('.project-menu .project-menu-item');
      if (firstMenuItem instanceof HTMLButtonElement) {
        firstMenuItem.focus();
      }
    });
  }

  async openProjectInPreferredEditor(group: ProjectGroup, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!group.path) {
      return;
    }

    this.closeProjectMenu();
    await this.fileIpc.editorOpenDirectory(group.path);
  }

  async openProjectInSystemFileManager(group: ProjectGroup, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!group.path) {
      return;
    }

    this.closeProjectMenu();
    await this.fileIpc.openPath(group.path);
  }

  async removeProject(group: ProjectGroup, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!group.path) {
      return;
    }

    this.closeProjectMenu();

    // Archive all history entries for this project
    for (const entry of group.historyItems) {
      await this.historyStore.archiveEntry(entry.id);
    }

    // Remove from recent directories
    await this.recentDirectoriesService.removeDirectory(group.path);
    await this.loadRecentDirectories();
  }

  startProjectConversation(group: ProjectGroup, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.closeProjectMenu({ restoreFocus: false });
    this.historyStore.clearSelection();
    const nodeId = this.getProjectNodeId(group);
    this.newSessionDraft.open(group.path, nodeId);
    this.store.setSelectedInstance(null);
  }

  private getProjectNodeId(group: ProjectGroup): string | null {
    // Check recent directories first (authoritative source for node mapping)
    if (group.path) {
      const recentEntry = this.recentDirectories().find(
        (entry) => this.getProjectKey(entry.path) === group.key,
      );
      if (recentEntry?.nodeId) {
        return recentEntry.nodeId;
      }
    }

    // Fall back to live instances' execution location
    const remoteItem = group.liveItems.find(
      (item) => item.instance.executionLocation?.type === 'remote',
    );
    const remoteLoc = remoteItem?.instance.executionLocation;
    return remoteLoc?.type === 'remote' ? remoteLoc.nodeId : null;
  }

  onDrop(event: CdkDragDrop<HierarchicalInstance[]>, group: ProjectGroup): void {
    const draggedItem = event.item.data as HierarchicalInstance;
    if (draggedItem.depth > 0) {
      return;
    }

    const groupRootIds = group.liveItems
      .filter((item) => item.depth === 0)
      .map((item) => item.instance.id);
    const fromRootIndex = groupRootIds.indexOf(draggedItem.instance.id);
    if (fromRootIndex === -1) {
      return;
    }

    const visibleRootIds = group.liveItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.depth === 0);

    const currentVisibleRootIndex = visibleRootIds.findIndex(({ index }) => index === event.currentIndex);
    const targetRootIndex = currentVisibleRootIndex === -1
      ? groupRootIds.length - 1
      : currentVisibleRootIndex;

    if (fromRootIndex === targetRootIndex) {
      return;
    }

    const reorderedGroupRoots = [...groupRootIds];
    moveItemInArray(reorderedGroupRoots, fromRootIndex, targetRootIndex);

    const currentOrderedRoots = this.getOrderedRootIds(this.store.instances());
    const replacementQueue = [...reorderedGroupRoots];
    const groupSet = new Set(groupRootIds);
    const nextOrder = currentOrderedRoots.map((rootId) =>
      groupSet.has(rootId) ? replacementQueue.shift() ?? rootId : rootId
    );

    this.rootInstanceOrder.set(nextOrder);
    this.saveOrder(nextOrder);
  }

  async onProjectDrop(event: CdkDragDrop<ProjectGroup[]>): Promise<void> {
    if (this.isProjectDragDisabled()) {
      return;
    }

    const draggedGroup = event.item.data as ProjectGroup | undefined;
    if (!draggedGroup || !draggedGroup.path) {
      return;
    }

    const pathGroups = this.getDraggableProjectGroups(this.projectGroups());
    const fromIndex = pathGroups.findIndex(({ group }) => group.key === draggedGroup.key);
    if (fromIndex === -1) {
      return;
    }

    const visiblePathGroups = this.projectGroups()
      .map((group, index) => ({ group, index }))
      .filter(
        (item): item is ProjectPathGroupIndex =>
          !!item.group.path && this.canDragProject(item.group)
      );
    const targetIndex = visiblePathGroups.findIndex(({ index }) => index === event.currentIndex);
    const toIndex = targetIndex === -1 ? pathGroups.length - 1 : targetIndex;

    if (fromIndex === toIndex) {
      return;
    }

    // Ensure all paths are registered in the recent-directories store before
    // reordering. Remote paths may not have been synced yet if the user drags
    // before the background sync effect runs.
    const knownPaths = new Set(
      this.recentDirectories().map((entry) => this.getProjectKey(entry.path))
    );
    const unregistered = pathGroups.filter(
      ({ group }) => !knownPaths.has(group.key)
    );
    if (unregistered.length > 0) {
      await Promise.all(
        unregistered.map(({ group }) => {
          const remoteItem = group.liveItems.find(
            (item) => item.instance.executionLocation?.type === 'remote'
          );
          const remoteLoc = remoteItem?.instance.executionLocation;
          const nodeId =
            remoteLoc?.type === 'remote' ? remoteLoc.nodeId : undefined;
          return this.recentDirectoriesService.addDirectory(
            group.path!,
            nodeId ? { nodeId } : undefined
          );
        })
      );
      await this.loadRecentDirectories();
    }

    const nextOrder = this.getNextProjectPathOrder(pathGroups, fromIndex, toIndex);
    const updated = await this.recentDirectoriesService.reorderDirectories(nextOrder);
    if (updated) {
      await this.loadRecentDirectories();
    }
  }

  async onRestoreHistory(entryId: string): Promise<void> {
    if (this.historyRail.restoringHistoryIds().has(entryId)) {
      return;
    }

    this.closeProjectMenu({ restoreFocus: false });
    this.historyRail.restoringHistoryIds.update((current) => new Set(current).add(entryId));
    const selectedAtStart = this.selectedId();
    const requestId = ++this.restoreSelectionRequestId;

    try {
      const entry = this.historyStore.entries().find((item) => item.id === entryId);
      const result = await this.historyStore.restoreEntry(entryId, entry?.workingDirectory);
      if (result.success && result.instanceId) {
        if (entry) {
          this.historyRail.markHistoryEntriesSeen([entry]);
        }
        // Populate restored messages into the new instance's output buffer.
        // The instance:created event may carry outputBuffer, but this explicit
        // call acts as a safety net against IPC race conditions (the event
        // fires via webContents.send while the response returns via
        // ipcMain.handle — ordering is not guaranteed).
        if (result.restoredMessages && result.restoredMessages.length > 0) {
          this.store.setInstanceMessages(
            result.instanceId,
            result.restoredMessages as OutputMessage[]
          );
        }
        // Preserve how the session was restored so the UI can adapt
        if (result.restoreMode) {
          this.store.setInstanceRestoreMode(result.instanceId, result.restoreMode);
        }
        if (this.shouldSelectRestoredHistory(requestId, selectedAtStart, result.instanceId)) {
          this.historyStore.clearSelection();
          this.store.setSelectedInstance(result.instanceId);
        }
      } else if (result.error) {
        console.error('Failed to restore history entry:', result.error);
      }
    } finally {
      this.historyRail.restoringHistoryIds.update((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
    }
  }

  async onPreviewHistory(entryId: string): Promise<void> {
    if (this.historyRail.restoringHistoryIds().has(entryId)) {
      return;
    }

    this.closeProjectMenu({ restoreFocus: false });
    this.pendingArchiveId.set(null);

    const entry = this.historyStore.entries().find((item) => item.id === entryId);
    const conversation = await this.historyStore.loadConversation(entryId, {
      selectForPreview: true,
    });
    if (!conversation) {
      console.error('Failed to load history entry for preview:', entryId);
      return;
    }

    if (entry) {
      this.historyRail.markHistoryEntriesSeen([entry]);
      this.lastVisitedHistoryThreadId.set(this.historyRail.getHistoryThreadId(entry));
    }

    this.store.setSelectedInstance(null);
  }

  private shouldSelectRestoredHistory(
    requestId: number,
    selectedAtStart: string | null,
    restoredInstanceId: string
  ): boolean {
    if (requestId !== this.restoreSelectionRequestId) {
      return false;
    }

    const selectedNow = this.selectedId();
    return selectedNow === selectedAtStart || selectedNow === restoredInstanceId;
  }

  onArchiveHistory(entryId: string, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.closeProjectMenu({ restoreFocus: false });
    this.pendingArchiveId.set(entryId);
  }

  async confirmArchiveHistory(entryId: string, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.pendingArchiveId.set(null);
    await this.historyStore.archiveEntry(entryId);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target;
    const targetEl = target instanceof Element ? target : null;

    if (this.filtersOpen() && (!targetEl || !targetEl.closest('.filters-anchor'))) {
      this.filtersOpen.set(false);
    }

    if (this.openProjectMenuKey() && (!targetEl || !targetEl.closest('.project-menu-anchor'))) {
      this.closeProjectMenu({ restoreFocus: false });
    }

    // Any click outside the archive request/confirm buttons cancels the pending
    // archive (those button handlers call stopPropagation so they never reach
    // the document handler).
    if (this.pendingArchiveId() !== null) {
      this.pendingArchiveId.set(null);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') {
      return;
    }

    if (this.pendingArchiveId() !== null) {
      event.preventDefault();
      this.pendingArchiveId.set(null);
      return;
    }

    if (this.filtersOpen()) {
      event.preventDefault();
      this.filtersOpen.set(false);
      return;
    }

    if (this.openProjectMenuKey()) {
      event.preventDefault();
      this.closeProjectMenu();
    }
  }

  toggleFiltersPopover(event: MouseEvent): void {
    event.stopPropagation();
    this.filtersOpen.update((open) => !open);
  }

  onProjectMenuKeyDown(event: KeyboardEvent): void {
    if (!this.openProjectMenuKey()) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeProjectMenu();
      return;
    }

    const items = this.getProjectMenuItems();
    if (items.length === 0) {
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      const currentIndex = items.findIndex((item) => item === document.activeElement);
      if (currentIndex === -1) {
        (event.shiftKey ? items[items.length - 1] : items[0])?.focus();
        return;
      }

      const nextIndex = event.shiftKey
        ? (currentIndex - 1 + items.length) % items.length
        : (currentIndex + 1 + items.length) % items.length;
      items[nextIndex]?.focus();
      return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }

    event.preventDefault();
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex =
      event.key === 'ArrowDown'
        ? (currentIndex + 1 + items.length) % items.length
        : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  private buildHistoryEntriesByProject(
    entries: ConversationHistoryEntry[],
    filter: string,
    status: string,
    location: 'all' | 'local' | 'remote' = 'all',
    activityCutoff: number | null = null
  ): Map<string, ConversationHistoryEntry[]> {
    const groups = new Map<string, ConversationHistoryEntry[]>();
    if (status !== 'all') {
      return groups;
    }

    for (const entry of entries) {
      // Location filter: match history entries by their archived executionLocation.
      // Entries without executionLocation are treated as local (pre-remote-node history).
      if (location === 'remote' && entry.executionLocation?.type !== 'remote') {
        continue;
      }
      if (location === 'local' && entry.executionLocation?.type === 'remote') {
        continue;
      }
      if (activityCutoff !== null && entry.endedAt < activityCutoff) {
        continue;
      }

      const title = this.getProjectTitle(entry.workingDirectory);
      const subtitle = this.getProjectSubtitle(entry.workingDirectory);

      if (
        filter &&
        !this.projectGroupComputation.matchesProjectText(title, subtitle, filter) &&
        !this.projectGroupComputation.matchesHistoryText(entry, filter)
      ) {
        continue;
      }

      const projectKey = this.getProjectKey(entry.workingDirectory);
      const projectEntries = groups.get(projectKey) ?? [];
      projectEntries.push(entry);
      groups.set(projectKey, projectEntries);
    }

    const pinnedIds = this.historyRail.pinnedHistoryIds();
    const sortMode = this.historySortMode();
    for (const projectEntries of groups.values()) {
      projectEntries.sort((left, right) => {
        const leftPinned = pinnedIds.has(left.id);
        const rightPinned = pinnedIds.has(right.id);
        if (leftPinned !== rightPinned) {
          return leftPinned ? -1 : 1;
        }
        return this.historyRail.getHistorySortTimestamp(right, sortMode) - this.historyRail.getHistorySortTimestamp(left, sortMode);
      });

      const dedupedEntries: ConversationHistoryEntry[] = [];
      const seenThreadIds = new Set<string>();

      for (const entry of projectEntries) {
        const dedupeKey = this.historyRail.getHistoryThreadId(entry);
        if (seenThreadIds.has(dedupeKey)) {
          continue;
        }
        seenThreadIds.add(dedupeKey);
        dedupedEntries.push(entry);
      }

      const activeEntries = dedupedEntries.filter((entry) => !entry.archivedAt);
      // Fallback is meant to keep "thin" projects from looking empty — only
      // surface archived entries when the project has at least one active one.
      // If every entry is archived, the project group is fully removed.
      const archivedFallbackIds = new Set(
        activeEntries.length === 0
          ? []
          : dedupedEntries
              .filter((entry) => !!entry.archivedAt)
              .slice(0, Math.max(0, InstanceListComponent.MIN_VISIBLE_HISTORY_THREADS - activeEntries.length))
              .map((entry) => entry.id)
      );
      const visibleEntries = dedupedEntries.filter(
        (entry) => !entry.archivedAt || archivedFallbackIds.has(entry.id)
      );

      projectEntries.length = 0;
      projectEntries.push(...visibleEntries);
    }

    return groups;
  }

  private getOrderedRootInstances(instances: Instance[]): Instance[] {
    const orderedRootIds = this.getOrderedRootIds(instances);
    const instanceMap = new Map(instances.map((instance) => [instance.id, instance]));
    return orderedRootIds
      .map((id) => instanceMap.get(id))
      .filter((instance): instance is Instance => !!instance);
  }

  private getOrderedRootIds(instances: Instance[]): string[] {
    const roots = instances.filter((instance) => !instance.parentId);
    const customOrder = this.rootInstanceOrder();

    return [...roots]
      .sort((left, right) => {
        const leftIndex = customOrder.indexOf(left.id);
        const rightIndex = customOrder.indexOf(right.id);

        if (leftIndex !== -1 && rightIndex !== -1) {
          return leftIndex - rightIndex;
        }
        if (leftIndex !== -1) {
          return -1;
        }
        if (rightIndex !== -1) {
          return 1;
        }
        return left.createdAt - right.createdAt;
      })
      .map((instance) => instance.id);
  }

  private getProjectKey(workingDirectory: string | null | undefined): string {
    const normalized = (workingDirectory ?? '').trim();
    return normalized ? normalized.toLowerCase() : NO_WORKSPACE_KEY;
  }

  private getProjectTitle(workingDirectory: string | null | undefined): string {
    const normalized = (workingDirectory ?? '').trim();
    if (!normalized) {
      return 'No workspace';
    }

    const parts = normalized.split(/[/\\]/).filter(Boolean);
    return parts.at(-1) ?? normalized;
  }

  private getProjectSubtitle(workingDirectory: string | null | undefined): string {
    const normalized = (workingDirectory ?? '').trim();
    if (!normalized) {
      return 'Sessions without a working directory';
    }

    return normalized
      .replace(/^\/Users\/[^/]+/, '~')
      .replace(/^\/home\/[^/]+/, '~');
  }

  private loadOrder(): string[] {
    try {
      const saved = localStorage.getItem(ORDER_STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  private saveOrder(order: string[]): void {
    try {
      localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
    } catch {
      // Ignore storage errors.
    }
  }

  isRestoringHistory(entryId: string): boolean {
    return this.historyRail.isRestoringHistory(entryId);
  }

  isSelectedHistory(entryId: string): boolean {
    return this.selectedId() === null && this.historyStore.previewEntryId() === entryId;
  }

  getVisibleHistoryItems(group: ProjectGroup): ConversationHistoryEntry[] {
    return this.historyRail.getVisibleHistoryItems(group);
  }

  toggleHistoryExpanded(key: string): void {
    this.historyRail.toggleHistoryExpanded(key);
  }

  isPinnedHistory(entryId: string): boolean {
    return this.historyRail.isPinnedHistory(entryId);
  }

  togglePinnedHistory(entryId: string, event: Event): void {
    this.historyRail.togglePinnedHistory(entryId, event);
  }

  getHistoryTitle(entry: ConversationHistoryEntry): string {
    return this.historyRail.getHistoryTitle(entry);
  }

  getHistoryPreviewTitle(entry: ConversationHistoryEntry): string {
    return this.historyRail.getHistoryPreviewTitle(entry);
  }

  getHistoryChangeSummary(entry: ConversationHistoryEntry): RailChangeSummary | null {
    return this.historyRail.getHistoryChangeSummary(entry);
  }

  getHistoryProviderVisual(entry: ConversationHistoryEntry): {
    icon: 'anthropic' | 'openai' | 'google' | 'github' | 'cursor' | 'generic';
    color: string;
    label: string;
  } {
    return this.historyRail.getHistoryProviderVisual(entry);
  }

  formatRelativeTime(timestamp: number): string {
    return this.historyRail.formatRelativeTime(timestamp);
  }

  formatHistoryTime(entry: ConversationHistoryEntry): string {
    return this.historyRail.formatHistoryTime(entry, this.historySortMode());
  }

  getProjectDraftTitle(group: ProjectGroup): string {
    if (!group.draftUpdatedAt) {
      return 'Draft saved';
    }

    return `Draft updated ${this.formatRelativeTime(group.draftUpdatedAt)} ago`;
  }

  private getLiveRailTitle(
    instance: Instance,
    matchingHistoryEntry?: ConversationHistoryEntry
  ): string {
    // Delegate to the shared resolver so the rail and the detail header
    // always agree on the displayed title. See
    // `resolveEffectiveInstanceTitle` in shared/types/history.types.ts
    // for the priority rules.
    return resolveEffectiveInstanceTitle(instance, matchingHistoryEntry);
  }

  private getLatestHistoryEntriesByThread(
    entries: readonly ConversationHistoryEntry[]
  ): Map<string, ConversationHistoryEntry> {
    const latestEntries = new Map<string, ConversationHistoryEntry>();

    for (const entry of entries) {
      const threadId = this.historyRail.getHistoryThreadId(entry);
      const current = latestEntries.get(threadId);
      if (!current || entry.endedAt > current.endedAt) {
        latestEntries.set(threadId, entry);
      }
    }

    return latestEntries;
  }

  private getInstanceThreadId(
    instance: Pick<Instance, 'historyThreadId' | 'sessionId' | 'id'>
  ): string {
    const historyThreadId = instance.historyThreadId.trim();
    if (historyThreadId) {
      return historyThreadId;
    }

    const sessionId = instance.sessionId.trim();
    if (sessionId) {
      return sessionId;
    }

    return instance.id;
  }

  private async loadRecentDirectories(): Promise<void> {
    const directories = await this.recentDirectoriesService.getDirectories({
      sortBy: 'manual',
    });
    if (this.areRecentDirectoriesEqual(this.recentDirectories(), directories)) {
      return;
    }
    this.recentDirectories.set(directories);
  }

  private async syncRecentDirectories(
    items: readonly { path: string; nodeId?: string }[]
  ): Promise<void> {
    await Promise.all(
      items.map(({ path, nodeId }) =>
        this.recentDirectoriesService.addDirectory(
          path,
          nodeId ? { nodeId } : undefined
        )
      )
    );
    await this.loadRecentDirectories();
  }

  private areRecentDirectoriesEqual(
    left: readonly RecentDirectoryEntry[],
    right: readonly RecentDirectoryEntry[]
  ): boolean {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((entry, index) => {
      const candidate = right[index];
      return candidate !== undefined &&
        entry.path === candidate.path &&
        entry.displayName === candidate.displayName &&
        entry.lastAccessed === candidate.lastAccessed &&
        entry.accessCount === candidate.accessCount &&
        entry.isPinned === candidate.isPinned;
    });
  }

  private async ensurePreferredEditorLoaded(): Promise<void> {
    const response = await this.fileIpc.editorGetDefault();
    const editor = response.success && response.data && typeof response.data === 'object'
      ? (response.data as Record<string, unknown>)
      : null;
    const type = typeof editor?.['type'] === 'string' ? editor['type'] : null;
    if (!type) {
      this.preferredEditorLabel.set('Editor');
      return;
    }

    switch (type) {
      case 'vscode':
        this.preferredEditorLabel.set('VS Code');
        break;
      case 'vscode-insiders':
        this.preferredEditorLabel.set('VS Code Insiders');
        break;
      case 'cursor':
        this.preferredEditorLabel.set('Cursor');
        break;
      case 'xcode':
        this.preferredEditorLabel.set('Xcode');
        break;
      case 'android-studio':
        this.preferredEditorLabel.set('Android Studio');
        break;
      default:
        this.preferredEditorLabel.set(type.charAt(0).toUpperCase() + type.slice(1));
    }
  }

  private getSystemFileManagerLabel(): string {
    if (navigator.userAgent.includes('Windows')) {
      return 'Explorer';
    }
    if (navigator.userAgent.includes('Linux')) {
      return 'Files';
    }
    return 'Finder';
  }

  private getProjectSortTimestamp(group: ProjectGroup): number {
    if (this.historySortMode() === 'created') {
      return group.createdAt;
    }

    return group.lastActivity;
  }

  private loadSortMode(): HistorySortMode {
    try {
      const saved = localStorage.getItem(SORT_MODE_STORAGE_KEY);
      return saved === 'created' ? 'created' : 'last-interacted';
    } catch {
      return 'last-interacted';
    }
  }

  private saveSortMode(mode: HistorySortMode): void {
    try {
      localStorage.setItem(SORT_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage errors.
    }
  }

  private loadHistoryVisibilityMode(): HistoryVisibilityMode {
    try {
      const saved = localStorage.getItem(HISTORY_VISIBILITY_STORAGE_KEY);
      return saved === 'all' ? 'all' : 'relevant';
    } catch {
      return 'relevant';
    }
  }

  private saveHistoryVisibilityMode(mode: HistoryVisibilityMode): void {
    try {
      localStorage.setItem(HISTORY_VISIBILITY_STORAGE_KEY, mode);
    } catch {
      // Ignore storage errors.
    }
  }

  private loadHistoryTimeWindow(): HistoryTimeWindow {
    try {
      return this.parseHistoryTimeWindow(localStorage.getItem(HISTORY_TIME_WINDOW_STORAGE_KEY));
    } catch {
      return 'all';
    }
  }

  private saveHistoryTimeWindow(mode: HistoryTimeWindow): void {
    try {
      localStorage.setItem(HISTORY_TIME_WINDOW_STORAGE_KEY, mode);
    } catch {
      // Ignore storage errors.
    }
  }

  private parseHistoryTimeWindow(value: string | null): HistoryTimeWindow {
    switch (value) {
      case 'day':
      case '3-days':
      case 'week':
      case '2-weeks':
      case 'month':
        return value;
      default:
        return 'all';
    }
  }

  canDragProject(group: ProjectGroup): boolean {
    return !this.isProjectDragDisabled() && !!group.path;
  }

  private getDraggableProjectGroups(groups: ProjectGroup[]): ProjectPathGroupIndex[] {
    return groups
      .map((group, index) => ({ group, index }))
      .filter(
        (item): item is ProjectPathGroupIndex =>
          !!item.group.path && this.canDragProject(item.group)
      );
  }

  private getNextProjectPathOrder(
    pathGroups: readonly ProjectPathGroupIndex[],
    fromIndex: number,
    toIndex: number
  ): string[] {
    const visiblePaths = pathGroups.map(({ group }) => group.path!);
    const reorderedVisiblePaths = [...visiblePaths];
    moveItemInArray(reorderedVisiblePaths, fromIndex, toIndex);

    const visiblePathKeys = new Set(visiblePaths.map((dirPath) => this.getProjectKey(dirPath)));
    const recentDirectoryPaths = this.recentDirectories().map((entry) => entry.path);
    const recentDirectoryKeys = new Set(
      recentDirectoryPaths.map((dirPath) => this.getProjectKey(dirPath))
    );
    const completeOrder = [
      ...recentDirectoryPaths,
      ...visiblePaths.filter((dirPath) =>
        !recentDirectoryKeys.has(this.getProjectKey(dirPath))
      ),
    ];
    const replacementQueue = [...reorderedVisiblePaths];

    return completeOrder.map((dirPath) =>
      visiblePathKeys.has(this.getProjectKey(dirPath))
        ? replacementQueue.shift() ?? dirPath
        : dirPath
    );
  }

  private closeProjectMenu(options: { restoreFocus?: boolean } = {}): void {
    const restoreFocus = options.restoreFocus ?? true;
    if (!this.openProjectMenuKey()) {
      return;
    }

    this.openProjectMenuKey.set(null);
    if (restoreFocus) {
      this.projectMenuTrigger?.focus();
    }
    this.projectMenuTrigger = null;
  }

  private getProjectMenuItems(): HTMLButtonElement[] {
    return Array.from(this.host.nativeElement.querySelectorAll('.project-menu .project-menu-item'))
      .filter((item): item is HTMLButtonElement => item instanceof HTMLButtonElement);
  }
}
