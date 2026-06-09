import { Injectable, inject } from '@angular/core';
import type { Instance } from '../../core/state/instance.store';
import { resolveEffectiveInstanceTitle } from '../../../../shared/types/history.types';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { RecentDirectoryEntry } from '../../../../shared/types/recent-directories.types';
import { ProjectGroupComputationService } from './project-group-computation.service';
import { HistoryRailService } from './history-rail.service';
import { ProjectRailPathService } from './project-rail-path.service';
import {
  getHistoryTimeWindowCutoff,
  type HistoryTimeWindow,
  type HistoryVisibilityMode,
  shouldShowHistoryOnlyProject,
} from './history-rail-filtering';
import {
  CHATS_KEY,
  ORPHANED_CHILDREN_KEY,
  getInstanceThreadId,
  type HierarchicalInstance,
  type HistorySortMode,
  type ProjectGroup,
} from './instance-list.types';
import {
  flattenHistoryNodes,
  flattenLiveItems,
  getOrderedOrphanedChildInstances,
  getOrderedRootInstances,
} from './project-rail-tree.utils';

export interface ProjectRailBuildInput {
  instances: Instance[];
  historyEntries: ConversationHistoryEntry[];
  recentDirectories: RecentDirectoryEntry[];
  filter: string;
  status: string;
  location: 'all' | 'local' | 'remote';
  historyVisibility: HistoryVisibilityMode;
  historyTimeWindow: HistoryTimeWindow;
  selectedId: string | null;
  selectedHistoryEntryId: string | null;
  collapsed: Set<string>;
  collapsedProjects: Set<string>;
  collapsedHistoryParentIds: Set<string>;
  historySortMode: HistorySortMode;
  rootInstanceOrder: string[];
  showEmptyProjects: boolean;
}

@Injectable({ providedIn: 'root' })
export class ProjectRailBuilderService {
  private projectGroupComputation = inject(ProjectGroupComputationService);
  private historyRail = inject(HistoryRailService);
  private paths = inject(ProjectRailPathService);

  buildProjectGroups(input: ProjectRailBuildInput): ProjectGroup[] {
    const filter = input.filter.trim().toLowerCase();
    const activityCutoff = getHistoryTimeWindowCutoff(input.historyTimeWindow);
    const visibleInstances = input.instances.filter((instance) => !this.isProjectRailHiddenInstance(instance));
    const visibleHistoryEntries = input.historyEntries.filter((entry) => !entry.hideFromProjectRail);
    const childrenByParent = this.projectGroupComputation.buildChildrenMap(visibleInstances);
    const instanceMap = new Map(visibleInstances.map((instance) => [instance.id, instance]));
    const historyPartition = this.projectGroupComputation.partitionHistoryEntriesByParent(
      visibleHistoryEntries,
      instanceMap,
    );
    const visibleHistoryEntriesByParent = this.buildVisibleHistoryEntriesByParent(
      this.mergeHistoryEntriesByParent(
        historyPartition.childEntriesByLiveParent,
        historyPartition.childEntriesByHistoryParent,
      ),
      filter,
      input.status,
      input.location,
      activityCutoff,
      input.historySortMode,
    );
    const forcedHistoryParentIds = new Set(visibleHistoryEntriesByParent.keys());
    const historyByProject = this.buildHistoryEntriesByProject(
      historyPartition.rootEntries,
      filter,
      input.status,
      input.location,
      activityCutoff,
      forcedHistoryParentIds,
      input.historySortMode,
    );
    const orphanedChildHistoryItems = this.buildOrphanedChildHistoryItems(
      historyPartition.orphanedChildEntries,
      forcedHistoryParentIds,
      filter,
      input.status,
      input.location,
      activityCutoff,
      input.historySortMode,
    );
    const recentDirectoriesByKey = new Map(
      input.recentDirectories.map((entry) => [this.paths.getProjectKey(entry.path), entry]),
    );
    const recentDirectoryOrder = new Map(
      input.recentDirectories.map((entry, index) => [this.paths.getProjectKey(entry.path), index] as const),
    );
    const groups = new Map<string, ProjectGroup>();

    for (const root of getOrderedRootInstances(visibleInstances, input.rootInstanceOrder)) {
      const projectKey = this.paths.getProjectKey(root.workingDirectory);
      const title = this.paths.getProjectTitle(root.workingDirectory);
      const subtitle = this.paths.getProjectSubtitle(root.workingDirectory);
      const projectMatches = !!filter && this.projectGroupComputation.matchesProjectText(title, subtitle, filter);
      const rawHistoryItems = historyByProject.get(projectKey) ?? [];
      const existingGroup = groups.get(projectKey);
      const historyLookupItems = existingGroup
        ? flattenHistoryNodes(existingGroup.historyItems)
        : rawHistoryItems;
      const historyByThreadId = new Map(
        historyLookupItems.map((entry) => [this.historyRail.getHistoryThreadId(entry), entry]),
      );
      const liveRoot = this.projectGroupComputation.buildVisibleItems(
        root,
        {
          filter,
          status: input.status,
          location: input.location,
          projectMatches,
          collapsed: input.collapsed,
          collapsedHistoryParentIds: input.collapsedHistoryParentIds,
          historySortMode: input.historySortMode,
          childrenByParent,
          historyEntriesByParent: visibleHistoryEntriesByParent,
          instanceMap,
          activityCutoff,
        },
      );
      const liveItems = liveRoot
        ? [this.assignLiveRailTitles(liveRoot, historyByThreadId)]
        : [];
      const flatLiveItems = flattenLiveItems(liveItems);
      const liveThreadIds = new Set(
        flatLiveItems
          .map((item) => getInstanceThreadId(item.instance))
          .filter((threadId): threadId is string => threadId.trim().length > 0),
      );
      const historySourceItems = existingGroup
        ? flattenHistoryNodes(existingGroup.historyItems)
        : rawHistoryItems;
      const historyItems = historySourceItems.filter(
        (entry) => !liveThreadIds.has(this.historyRail.getHistoryThreadId(entry)),
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
        subtitle: recentDirectory ? this.paths.getProjectSubtitle(recentDirectory.path) : subtitle,
        createdAt: recentDirectory?.lastAccessed ?? root.createdAt,
        sessionCount: 0,
        busyCount: 0,
        hasSelectedInstance: false,
        isExpanded: !input.collapsedProjects.has(projectKey),
        isPinned: recentDirectory?.isPinned ?? false,
        hasDraft: draftInfo.hasDraft,
        draftUpdatedAt: draftInfo.draftUpdatedAt,
        projectStateLabel: 'Ready',
        projectStateTone: 'ready',
        lastActivity: recentDirectory?.lastAccessed ?? root.lastActivity ?? root.createdAt,
        liveItems: [],
        historyItems: [],
      };
      const previousHistoryCount = flattenHistoryNodes(group.historyItems).length;
      const groupedHistoryItems = this.projectGroupComputation.buildVisibleHistoryRoots(
        historyItems,
        visibleHistoryEntriesByParent,
        input.collapsedHistoryParentIds,
      );
      const allHistoryItems = flattenHistoryNodes(groupedHistoryItems);

      group.liveItems.push(...liveItems);
      group.createdAt = Math.max(
        group.createdAt,
        root.createdAt,
        ...rawHistoryItems.map((item) => item.createdAt),
        ...allHistoryItems.map((item) => item.createdAt),
      );
      group.sessionCount += flattenLiveItems(liveItems).length;
      group.busyCount += this.projectGroupComputation.countBusySessions(root, childrenByParent, instanceMap);
      group.hasSelectedInstance = group.hasSelectedInstance ||
        flatLiveItems.some((item) => item.instance.id === input.selectedId);
      group.isExpanded = !input.collapsedProjects.has(projectKey);
      group.historyItems = groupedHistoryItems;
      group.hasDraft = group.hasDraft || draftInfo.hasDraft;
      group.draftUpdatedAt = group.draftUpdatedAt ?? draftInfo.draftUpdatedAt;
      group.lastActivity = Math.max(
        group.lastActivity,
        root.lastActivity ?? root.createdAt,
        ...allHistoryItems.map((item) => item.endedAt),
      );
      Object.assign(
        group,
        this.projectGroupComputation.getProjectStateSummary(
          flattenLiveItems(group.liveItems),
          allHistoryItems,
          group.hasDraft,
        ),
      );
      group.sessionCount += allHistoryItems.length - previousHistoryCount;
      groups.set(projectKey, group);
      historyByProject.delete(projectKey);
      recentDirectoriesByKey.delete(projectKey);
    }

    const orphanedLiveRoots = getOrderedOrphanedChildInstances(visibleInstances, instanceMap)
      .map((root) =>
        this.projectGroupComputation.buildVisibleItems(
          root,
          {
            filter,
            status: input.status,
            location: input.location,
            projectMatches: this.projectGroupComputation.matchesProjectText(
              'Unlinked worker sessions',
              'Child sessions without a visible parent',
              filter,
            ),
            collapsed: input.collapsed,
            collapsedHistoryParentIds: input.collapsedHistoryParentIds,
            historySortMode: input.historySortMode,
            childrenByParent,
            historyEntriesByParent: visibleHistoryEntriesByParent,
            instanceMap,
            activityCutoff,
          },
        )
      )
      .filter((item): item is HierarchicalInstance => item !== null)
      .map((item) => this.assignLiveRailTitles(item));
    const orphanedFlatLiveItems = flattenLiveItems(orphanedLiveRoots);
    const orphanedHistoryItems = this.projectGroupComputation.buildVisibleHistoryRoots(
      orphanedChildHistoryItems,
      visibleHistoryEntriesByParent,
      input.collapsedHistoryParentIds,
    );
    const orphanedAllHistoryItems = flattenHistoryNodes(orphanedHistoryItems);

    if (orphanedLiveRoots.length > 0 || orphanedHistoryItems.length > 0) {
      groups.set(ORPHANED_CHILDREN_KEY, {
        key: ORPHANED_CHILDREN_KEY,
        path: null,
        title: 'Unlinked worker sessions',
        subtitle: 'Child sessions without a visible parent',
        createdAt: Math.max(
          0,
          ...orphanedFlatLiveItems.map((item) => item.instance.createdAt),
          ...orphanedAllHistoryItems.map((item) => item.createdAt),
        ),
        sessionCount: orphanedFlatLiveItems.length + orphanedAllHistoryItems.length,
        busyCount: orphanedLiveRoots.reduce(
          (count, root) =>
            count + this.projectGroupComputation.countBusySessions(root.instance, childrenByParent, instanceMap),
          0,
        ),
        hasSelectedInstance: orphanedFlatLiveItems.some((item) => item.instance.id === input.selectedId),
        isExpanded: !input.collapsedProjects.has(ORPHANED_CHILDREN_KEY),
        isPinned: false,
        hasDraft: false,
        draftUpdatedAt: null,
        ...this.projectGroupComputation.getProjectStateSummary(orphanedFlatLiveItems, orphanedAllHistoryItems, false),
        lastActivity: Math.max(
          0,
          ...orphanedFlatLiveItems.map((item) => item.instance.lastActivity ?? item.instance.createdAt),
          ...orphanedAllHistoryItems.map((item) => item.endedAt),
        ),
        liveItems: orphanedLiveRoots,
        historyItems: orphanedHistoryItems,
      });
    }

    for (const [projectKey, historyItems] of historyByProject) {
      if (historyItems.length === 0) {
        continue;
      }

      const recentDirectory = recentDirectoriesByKey.get(projectKey);
      const workingDirectory = recentDirectory?.path || historyItems[0].workingDirectory || null;
      const draftInfo = this.projectGroupComputation.getProjectDraftInfo(workingDirectory);
      const groupedHistoryItems = this.projectGroupComputation.buildVisibleHistoryRoots(
        historyItems,
        visibleHistoryEntriesByParent,
        input.collapsedHistoryParentIds,
      );
      const allHistoryItems = flattenHistoryNodes(groupedHistoryItems);
      if (!shouldShowHistoryOnlyProject({
        mode: input.historyVisibility,
        hasTextFilter: filter.length > 0,
        hasDraft: draftInfo.hasDraft,
        isPinnedProject: recentDirectory?.isPinned ?? false,
        selectedHistoryEntryId: input.selectedHistoryEntryId,
        pinnedHistoryIds: this.historyRail.pinnedHistoryIds(),
        historyItems: allHistoryItems,
      })) {
        recentDirectoriesByKey.delete(projectKey);
        continue;
      }

      groups.set(projectKey, {
        key: projectKey,
        path: workingDirectory,
        title: recentDirectory?.displayName || this.paths.getProjectTitle(historyItems[0].workingDirectory),
        subtitle: recentDirectory
          ? this.paths.getProjectSubtitle(recentDirectory.path)
          : this.paths.getProjectSubtitle(historyItems[0].workingDirectory),
        createdAt: Math.max(
          recentDirectory?.lastAccessed ?? 0,
          ...allHistoryItems.map((item) => item.createdAt),
        ),
        sessionCount: allHistoryItems.length,
        busyCount: 0,
        hasSelectedInstance: false,
        isExpanded: !input.collapsedProjects.has(projectKey),
        isPinned: recentDirectory?.isPinned ?? false,
        hasDraft: draftInfo.hasDraft,
        draftUpdatedAt: draftInfo.draftUpdatedAt,
        ...this.projectGroupComputation.getProjectStateSummary([], allHistoryItems, draftInfo.hasDraft),
        lastActivity: Math.max(
          recentDirectory?.lastAccessed ?? 0,
          ...allHistoryItems.map((item) => item.endedAt),
        ),
        liveItems: [],
        historyItems: groupedHistoryItems,
      });
      recentDirectoriesByKey.delete(projectKey);
    }

    if (input.status === 'all' && input.location !== 'remote') {
      for (const recentDirectory of recentDirectoriesByKey.values()) {
        const title = recentDirectory.displayName || this.paths.getProjectTitle(recentDirectory.path);
        const subtitle = this.paths.getProjectSubtitle(recentDirectory.path);
        if (filter && !this.projectGroupComputation.matchesProjectText(title, subtitle, filter)) {
          continue;
        }

        const projectKey = this.paths.getProjectKey(recentDirectory.path);
        const draftInfo = this.projectGroupComputation.getProjectDraftInfo(recentDirectory.path);
        // These recent directories have no live sessions and no visible history,
        // so they render as "No threads yet". Hide them unless the user opts in,
        // but always keep pinned projects and projects with an unsent draft —
        // those are intentional, not empty-list noise.
        if (!input.showEmptyProjects && !recentDirectory.isPinned && !draftInfo.hasDraft) {
          continue;
        }
        const recentActivity = Math.max(
          recentDirectory.lastAccessed,
          draftInfo.draftUpdatedAt ?? 0,
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
          isExpanded: !input.collapsedProjects.has(projectKey),
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
      if (left.key === CHATS_KEY !== (right.key === CHATS_KEY)) {
        return left.key === CHATS_KEY ? 1 : -1;
      }
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
        this.getProjectSortTimestamp(right, input.historySortMode) -
        this.getProjectSortTimestamp(left, input.historySortMode);
      if (timestampDelta !== 0) {
        return timestampDelta;
      }

      return left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
    });
  }

  private buildHistoryEntriesByProject(
    entries: ConversationHistoryEntry[],
    filter: string,
    status: string,
    location: 'all' | 'local' | 'remote',
    activityCutoff: number | null,
    forcedParentKeys: ReadonlySet<string>,
    historySortMode: HistorySortMode,
  ): Map<string, ConversationHistoryEntry[]> {
    const groups = new Map<string, ConversationHistoryEntry[]>();
    if (status !== 'all') {
      return groups;
    }

    for (const entry of entries) {
      const forcedVisible = forcedParentKeys.has(this.getHistoryParentKey(entry));
      if (!forcedVisible && !this.shouldIncludeHistoryEntry(entry, filter, status, location, activityCutoff)) {
        continue;
      }

      const projectKey = this.paths.getProjectKey(entry.workingDirectory);
      const projectEntries = groups.get(projectKey) ?? [];
      projectEntries.push(entry);
      groups.set(projectKey, projectEntries);
    }

    for (const projectEntries of groups.values()) {
      const forcedVisibleEntryIds = new Set(
        projectEntries
          .filter((entry) => forcedParentKeys.has(this.getHistoryParentKey(entry)))
          .map((entry) => entry.id),
      );
      const visibleEntries = this.sortDedupeAndApplyArchiveFallback(
        projectEntries,
        historySortMode,
        forcedVisibleEntryIds,
      );
      projectEntries.length = 0;
      projectEntries.push(...visibleEntries);
    }

    return groups;
  }

  private buildVisibleHistoryEntriesByParent(
    entriesByParent: ReadonlyMap<string, ConversationHistoryEntry[]>,
    filter: string,
    status: string,
    location: 'all' | 'local' | 'remote',
    activityCutoff: number | null,
    historySortMode: HistorySortMode,
  ): Map<string, ConversationHistoryEntry[]> {
    if (status !== 'all') {
      return new Map<string, ConversationHistoryEntry[]>();
    }

    const result = new Map<string, ConversationHistoryEntry[]>();
    const visibilityCache = new Map<string, boolean>();

    const collectVisibleEntries = (
      parentId: string,
      visitedParentIds: ReadonlySet<string>,
    ): boolean => {
      if (visibilityCache.has(parentId)) {
        return visibilityCache.get(parentId) ?? false;
      }
      if (visitedParentIds.has(parentId)) {
        return false;
      }

      const entries = entriesByParent.get(parentId) ?? [];
      if (entries.length === 0) {
        visibilityCache.set(parentId, false);
        return false;
      }

      const nextVisitedParentIds = new Set(visitedParentIds);
      nextVisitedParentIds.add(parentId);
      const visibleEntries: ConversationHistoryEntry[] = [];
      const forcedVisibleEntryIds = new Set<string>();

      for (const entry of entries) {
        const selfVisible = this.shouldIncludeHistoryEntry(entry, filter, status, location, activityCutoff);
        const descendantsVisible = collectVisibleEntries(
          this.getHistoryParentKey(entry),
          nextVisitedParentIds,
        );
        if (!selfVisible && !descendantsVisible) {
          continue;
        }
        visibleEntries.push(entry);
        if (!selfVisible && descendantsVisible) {
          forcedVisibleEntryIds.add(entry.id);
        }
      }

      const sortedEntries = this.sortDedupeAndApplyArchiveFallback(
        visibleEntries,
        historySortMode,
        forcedVisibleEntryIds,
      );
      const hasVisibleEntries = sortedEntries.length > 0;
      if (hasVisibleEntries) {
        result.set(parentId, sortedEntries);
      }
      visibilityCache.set(parentId, hasVisibleEntries);
      return hasVisibleEntries;
    };

    for (const parentId of entriesByParent.keys()) {
      collectVisibleEntries(parentId, new Set<string>());
    }

    return result;
  }

  private buildOrphanedChildHistoryItems(
    entries: readonly ConversationHistoryEntry[],
    forcedParentKeys: ReadonlySet<string>,
    filter: string,
    status: string,
    location: 'all' | 'local' | 'remote',
    activityCutoff: number | null,
    historySortMode: HistorySortMode,
  ): ConversationHistoryEntry[] {
    const visibleEntries = entries.filter((entry) =>
      forcedParentKeys.has(this.getHistoryParentKey(entry)) ||
      this.shouldIncludeHistoryEntry(entry, filter, status, location, activityCutoff),
    );
    const forcedVisibleEntryIds = new Set(
      visibleEntries
        .filter((entry) => forcedParentKeys.has(this.getHistoryParentKey(entry)))
        .map((entry) => entry.id),
    );
    return this.sortDedupeAndApplyArchiveFallback(visibleEntries, historySortMode, forcedVisibleEntryIds);
  }

  private mergeHistoryEntriesByParent(
    ...maps: readonly ReadonlyMap<string, ConversationHistoryEntry[]>[]
  ): Map<string, ConversationHistoryEntry[]> {
    const result = new Map<string, ConversationHistoryEntry[]>();
    for (const map of maps) {
      for (const [parentId, entries] of map) {
        const siblings = result.get(parentId) ?? [];
        siblings.push(...entries);
        result.set(parentId, siblings);
      }
    }
    return result;
  }

  private getHistoryParentKey(entry: ConversationHistoryEntry): string {
    return entry.originalInstanceId.trim() || entry.id;
  }

  private shouldIncludeHistoryEntry(
    entry: ConversationHistoryEntry,
    filter: string,
    status: string,
    location: 'all' | 'local' | 'remote',
    activityCutoff: number | null,
  ): boolean {
    if (status !== 'all') {
      return false;
    }

    if (location === 'remote' && entry.executionLocation?.type !== 'remote') {
      return false;
    }
    if (location === 'local' && entry.executionLocation?.type === 'remote') {
      return false;
    }
    if (activityCutoff !== null && entry.endedAt < activityCutoff) {
      return false;
    }

    const title = this.paths.getProjectTitle(entry.workingDirectory);
    const subtitle = this.paths.getProjectSubtitle(entry.workingDirectory);

    return !filter ||
      this.projectGroupComputation.matchesProjectText(title, subtitle, filter) ||
      this.projectGroupComputation.matchesHistoryText(entry, filter);
  }

  private sortDedupeAndApplyArchiveFallback(
    entries: readonly ConversationHistoryEntry[],
    historySortMode: HistorySortMode,
    alwaysIncludeIds: ReadonlySet<string> = new Set<string>(),
  ): ConversationHistoryEntry[] {
    const pinnedIds = this.historyRail.pinnedHistoryIds();
    const sortedEntries = [...entries].sort((left, right) => {
      const leftPinned = pinnedIds.has(left.id);
      const rightPinned = pinnedIds.has(right.id);
      if (leftPinned !== rightPinned) {
        return leftPinned ? -1 : 1;
      }
      return this.historyRail.getHistorySortTimestamp(right, historySortMode) -
        this.historyRail.getHistorySortTimestamp(left, historySortMode);
    });

    const dedupedEntries: ConversationHistoryEntry[] = [];
    const seenThreadIds = new Set<string>();

    for (const entry of sortedEntries) {
      const dedupeKey = this.historyRail.getHistoryThreadId(entry);
      if (seenThreadIds.has(dedupeKey)) {
        continue;
      }
      seenThreadIds.add(dedupeKey);
      dedupedEntries.push(entry);
    }

    return dedupedEntries.filter(
      (entry) => alwaysIncludeIds.has(entry.id) || !entry.archivedAt,
    );
  }

  private assignLiveRailTitles(
    item: HierarchicalInstance,
    historyByThreadId: ReadonlyMap<string, ConversationHistoryEntry> = new Map(),
  ): HierarchicalInstance {
    return {
      ...item,
      railTitle: resolveEffectiveInstanceTitle(
        item.instance,
        historyByThreadId.get(getInstanceThreadId(item.instance)),
      ),
      children: item.children.map((child) =>
        child.kind === 'live' ? this.assignLiveRailTitles(child, historyByThreadId) : child,
      ),
    };
  }

  private getProjectSortTimestamp(group: ProjectGroup, historySortMode: HistorySortMode): number {
    if (historySortMode === 'created') {
      return group.createdAt;
    }

    return group.lastActivity;
  }

  private isProjectRailHiddenInstance(instance: Instance): boolean {
    return instance.metadata?.['hideFromProjectRail'] === true
      || typeof instance.metadata?.['spawnDepth'] === 'number';
  }
}
