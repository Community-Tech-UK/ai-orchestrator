import { Injectable, inject } from '@angular/core';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import type { Instance } from '../../core/state/instance.store';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type {
  HierarchicalHistoryItem,
  HierarchicalInstance,
  HierarchicalRailItem,
} from './instance-list.types';

interface ProjectStateSummary {
  projectStateLabel: string;
  projectStateTone: 'working' | 'attention' | 'connecting' | 'ready' | 'history';
}

export interface HistoryEntryParentPartition {
  rootEntries: ConversationHistoryEntry[];
  childEntriesByLiveParent: Map<string, ConversationHistoryEntry[]>;
  childEntriesByHistoryParent: Map<string, ConversationHistoryEntry[]>;
  orphanedChildEntries: ConversationHistoryEntry[];
}

@Injectable({ providedIn: 'root' })
export class ProjectGroupComputationService {
  private newSessionDraft = inject(NewSessionDraftService);

  /**
   * Statuses that count as "Active" in the State filter: live/current sessions
   * that are not archived into hibernation or a terminal/error state. This is
   * broader than the exact-match "Busy" option and intentionally includes idle
   * sessions.
   */
  private static readonly ACTIVE_STATUSES: ReadonlySet<Instance['status']> = new Set([
    'initializing',
    'ready',
    'idle',
    'busy',
    'processing',
    'thinking_deeply',
    'waiting_for_input',
    'waiting_for_permission',
    'interrupting',
    'cancelling',
    'interrupt-escalating',
    'respawning',
    'hibernating',
    'waking',
    'degraded',
  ]);

  isActiveStatus(status: Instance['status']): boolean {
    return ProjectGroupComputationService.ACTIVE_STATUSES.has(status);
  }

  buildChildrenMap(instances: Instance[]): Map<string, string[]> {
    const childrenByParent = new Map<string, string[]>();
    for (const instance of instances) {
      if (!instance.parentId) {
        continue;
      }

      const siblings = childrenByParent.get(instance.parentId) ?? [];
      siblings.push(instance.id);
      childrenByParent.set(instance.parentId, siblings);
    }
    return childrenByParent;
  }

  buildVisibleItems(
    instance: Instance,
    context: {
      filter: string;
      status: string;
      location: 'all' | 'local' | 'remote';
      projectMatches: boolean;
      collapsed: Set<string>;
      collapsedHistoryParentIds: ReadonlySet<string>;
      historySortMode: 'last-interacted' | 'created';
      childrenByParent: Map<string, string[]>;
      historyEntriesByParent?: ReadonlyMap<string, readonly ConversationHistoryEntry[]>;
      instanceMap: Map<string, Instance>;
      activityCutoff: number | null;
    }
  ): HierarchicalInstance | null {
    if (this.isSupersededEditSourceWithReplacement(instance, context.instanceMap)) {
      return null;
    }

    const childrenIds = context.childrenByParent.get(instance.id) ?? [];
    const children = childrenIds
      .map((childId) => context.instanceMap.get(childId))
      .filter((child): child is Instance => child !== undefined)
      .sort((left, right) => left.createdAt - right.createdAt);
    const visibleLiveChildren = children
      .map((child) => this.buildVisibleItems(child, context))
      .filter((child): child is HierarchicalInstance => child !== null);
    const visibleHistoryChildren = context.historyEntriesByParent
      ? this.buildVisibleHistoryItems(instance.id, context.historyEntriesByParent, context.collapsedHistoryParentIds)
      : [];

    const textMatches = !context.filter ||
      context.projectMatches ||
      this.matchesInstanceText(instance, context.filter);
    const statusMatches =
      context.status === 'all' ||
      (context.status === 'active'
        ? this.isActiveStatus(instance.status)
        : instance.status === context.status);
    const locationMatches =
      context.location === 'all' ||
      (context.location === 'remote' && instance.executionLocation?.type === 'remote') ||
      (context.location === 'local' && (instance.executionLocation === undefined || instance.executionLocation.type === 'local'));
    const activityMatches =
      context.activityCutoff === null ||
      Math.max(instance.lastActivity, instance.createdAt) >= context.activityCutoff;
    const selfVisible = textMatches && statusMatches && locationMatches && activityMatches;

    if (!selfVisible && visibleLiveChildren.length === 0 && visibleHistoryChildren.length === 0) {
      return null;
    }

    const immediateChildren = this.sortRailChildren(
      visibleLiveChildren,
      visibleHistoryChildren,
      context.historySortMode
    );
    return {
      kind: 'live',
      instance: {
        ...instance,
        childrenIds,
      },
      railTitle: instance.displayName,
      hasChildren: immediateChildren.length > 0,
      childrenCount: immediateChildren.length,
      isExpanded: !context.collapsed.has(instance.id),
      children: immediateChildren,
    };
  }

  buildVisibleHistoryItems(
    parentKey: string,
    source: ReadonlyMap<string, readonly ConversationHistoryEntry[]>,
    collapsedHistoryParentIds: ReadonlySet<string>
  ): HierarchicalHistoryItem[] {
    return (source.get(parentKey) ?? []).map((entry) =>
      this.buildVisibleHistoryItem(entry, source, collapsedHistoryParentIds)
    );
  }

  buildVisibleHistoryRoots(
    roots: readonly ConversationHistoryEntry[],
    source: ReadonlyMap<string, readonly ConversationHistoryEntry[]>,
    collapsedHistoryParentIds: ReadonlySet<string>
  ): HierarchicalHistoryItem[] {
    return roots.map((entry) => this.buildVisibleHistoryItem(entry, source, collapsedHistoryParentIds));
  }

  partitionHistoryEntriesByParent(
    entries: readonly ConversationHistoryEntry[],
    instanceMap: ReadonlyMap<string, Instance>
  ): HistoryEntryParentPartition {
    const rootEntries: ConversationHistoryEntry[] = [];
    const childEntriesByLiveParent = new Map<string, ConversationHistoryEntry[]>();
    const childEntriesByHistoryParent = new Map<string, ConversationHistoryEntry[]>();
    const orphanedChildEntries: ConversationHistoryEntry[] = [];
    const historyParentIds = new Set(
      entries
        .map((entry) => entry.originalInstanceId.trim())
        .filter((id) => id.length > 0)
    );

    for (const entry of entries) {
      const parentId = entry.parentId?.trim() || null;
      if (!parentId) {
        rootEntries.push(entry);
        continue;
      }

      if (instanceMap.has(parentId)) {
        const siblings = childEntriesByLiveParent.get(parentId) ?? [];
        siblings.push(entry);
        childEntriesByLiveParent.set(parentId, siblings);
        continue;
      }

      if (historyParentIds.has(parentId)) {
        const siblings = childEntriesByHistoryParent.get(parentId) ?? [];
        siblings.push(entry);
        childEntriesByHistoryParent.set(parentId, siblings);
        continue;
      }

      orphanedChildEntries.push(entry);
    }

    return {
      rootEntries,
      childEntriesByLiveParent,
      childEntriesByHistoryParent,
      orphanedChildEntries,
    };
  }

  collectVisibleHistoryChildrenByParent(
    parents: readonly ConversationHistoryEntry[],
    source: ReadonlyMap<string, readonly ConversationHistoryEntry[]>
  ): Map<string, ConversationHistoryEntry[]> {
    const result = new Map<string, ConversationHistoryEntry[]>();
    for (const parent of parents) {
      const descendants = this.collectVisibleHistoryChildren(
        this.getHistoryParentKey(parent),
        source
      );
      if (descendants.length > 0) {
        result.set(this.getHistoryParentKey(parent), descendants);
      }
    }
    return result;
  }

  collectVisibleHistoryChildren(
    parentKey: string,
    source: ReadonlyMap<string, readonly ConversationHistoryEntry[]>
  ): ConversationHistoryEntry[] {
    return this.collectHistoryDescendants(parentKey, source, new Set<string>());
  }

  countSessionsInTree(
    instance: Instance,
    childrenByParent: Map<string, string[]>,
    instanceMap: Map<string, Instance>
  ): number {
    if (this.isSupersededEditSourceWithReplacement(instance, instanceMap)) {
      return 0;
    }

    const childrenIds = childrenByParent.get(instance.id) ?? [];
    return 1 + childrenIds.reduce((count, childId) => {
      const child = instanceMap.get(childId);
      return child ? count + this.countSessionsInTree(child, childrenByParent, instanceMap) : count;
    }, 0);
  }

  countBusySessions(
    instance: Instance,
    childrenByParent: Map<string, string[]>,
    instanceMap: Map<string, Instance>
  ): number {
    if (this.isSupersededEditSourceWithReplacement(instance, instanceMap)) {
      return 0;
    }

    const isBusy = instance.status === 'busy' || instance.status === 'initializing' || instance.status === 'waiting_for_input';
    const childrenIds = childrenByParent.get(instance.id) ?? [];

    return (isBusy ? 1 : 0) + childrenIds.reduce((count, childId) => {
      const child = instanceMap.get(childId);
      return child ? count + this.countBusySessions(child, childrenByParent, instanceMap) : count;
    }, 0);
  }

  getProjectStateSummary(
    liveItems: HierarchicalInstance[],
    historyItems: ConversationHistoryEntry[],
    hasDraft: boolean
  ): ProjectStateSummary {
    const statuses = new Set(liveItems.map((item) => item.instance.status));

    if (statuses.has('error')) {
      return { projectStateLabel: 'Issue', projectStateTone: 'attention' };
    }
    if (statuses.has('waiting_for_input')) {
      return { projectStateLabel: 'Awaiting input', projectStateTone: 'attention' };
    }
    if (statuses.has('busy')) {
      return { projectStateLabel: 'Working', projectStateTone: 'working' };
    }
    if (
      statuses.has('initializing')
      || statuses.has('respawning')
      || statuses.has('interrupting')
      || statuses.has('cancelling')
      || statuses.has('interrupt-escalating')
    ) {
      return { projectStateLabel: 'Connecting', projectStateTone: 'connecting' };
    }
    if (liveItems.length > 0) {
      return { projectStateLabel: 'Ready', projectStateTone: 'ready' };
    }
    if (hasDraft) {
      return { projectStateLabel: 'Draft ready', projectStateTone: 'ready' };
    }
    if (historyItems.length > 0) {
      return { projectStateLabel: 'Recent history', projectStateTone: 'history' };
    }
    return { projectStateLabel: 'Available', projectStateTone: 'history' };
  }

  getProjectDraftInfo(workingDirectory: string | null | undefined): {
    hasDraft: boolean;
    draftUpdatedAt: number | null;
  } {
    if (!workingDirectory) {
      return {
        hasDraft: false,
        draftUpdatedAt: null,
      };
    }

    return {
      hasDraft: this.newSessionDraft.hasSavedDraftFor(workingDirectory),
      draftUpdatedAt: this.newSessionDraft.getDraftUpdatedAt(workingDirectory),
    };
  }

  matchesProjectText(title: string, subtitle: string, filter: string): boolean {
    return this.matchesFilterTerms(filter, title, subtitle);
  }

  matchesInstanceText(instance: Instance, filter: string): boolean {
    return this.matchesFilterTerms(
      filter,
      instance.displayName,
      instance.id,
      instance.historyThreadId,
      instance.sessionId,
      instance.providerSessionId,
      instance.provider,
      instance.currentModel,
      instance.agentId,
      instance.status,
      instance.workingDirectory
    );
  }

  matchesHistoryText(entry: ConversationHistoryEntry, filter: string): boolean {
    return this.matchesFilterTerms(
      filter,
      entry.displayName,
      entry.firstUserMessage,
      entry.lastUserMessage,
      entry.workingDirectory,
      entry.id,
      entry.historyThreadId,
      entry.sessionId,
      entry.originalInstanceId,
      entry.provider,
      entry.currentModel,
      entry.status
    );
  }

  private matchesFilterTerms(
    filter: string,
    ...fields: readonly (string | null | undefined)[]
  ): boolean {
    const terms = this.getFilterTerms(filter);
    if (terms.length === 0) {
      return true;
    }

    const haystack = fields
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .toLowerCase();

    return terms.every((term) => haystack.includes(term));
  }

  private getFilterTerms(filter: string): string[] {
    return filter
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);
  }

  private isSupersededEditSourceWithReplacement(
    instance: Instance,
    instanceMap: Map<string, Instance>
  ): boolean {
    return instance.status === 'superseded'
      && instance.cancelledForEdit === true
      && typeof instance.supersededBy === 'string'
      && instanceMap.has(instance.supersededBy);
  }

  private buildVisibleHistoryItem(
    entry: ConversationHistoryEntry,
    source: ReadonlyMap<string, readonly ConversationHistoryEntry[]>,
    collapsedHistoryParentIds: ReadonlySet<string>
  ): HierarchicalHistoryItem {
    const children = this.buildVisibleHistoryItems(
      this.getHistoryParentKey(entry),
      source,
      collapsedHistoryParentIds
    );
    return {
      kind: 'history',
      entry,
      hasChildren: children.length > 0,
      childrenCount: children.length,
      isExpanded: !collapsedHistoryParentIds.has(this.getHistoryCollapseKey(entry)),
      children,
    };
  }

  private sortRailChildren(
    liveChildren: readonly HierarchicalInstance[],
    historyChildren: readonly HierarchicalHistoryItem[],
    historySortMode: 'last-interacted' | 'created'
  ): HierarchicalRailItem[] {
    return [...liveChildren, ...historyChildren].sort((left, right) => {
      const timestampDelta =
        this.getRailChildSortTimestamp(right, historySortMode) -
        this.getRailChildSortTimestamp(left, historySortMode);
      if (timestampDelta !== 0) {
        return timestampDelta;
      }
      return left.kind === 'live' && right.kind === 'history'
        ? -1
        : left.kind === 'history' && right.kind === 'live'
          ? 1
          : 0;
    });
  }

  private getRailChildSortTimestamp(
    item: HierarchicalRailItem,
    historySortMode: 'last-interacted' | 'created'
  ): number {
    if (item.kind === 'live') {
      return historySortMode === 'created'
        ? item.instance.createdAt
        : item.instance.lastActivity ?? item.instance.createdAt;
    }

    return historySortMode === 'created' ? item.entry.createdAt : item.entry.endedAt;
  }

  private collectHistoryDescendants(
    parentKey: string,
    source: ReadonlyMap<string, readonly ConversationHistoryEntry[]>,
    visitedParentKeys: ReadonlySet<string>
  ): ConversationHistoryEntry[] {
    if (visitedParentKeys.has(parentKey)) {
      return [];
    }

    const nextVisitedParentKeys = new Set(visitedParentKeys);
    nextVisitedParentKeys.add(parentKey);
    const directChildren = source.get(parentKey) ?? [];
    const descendants: ConversationHistoryEntry[] = [];
    const seenEntryIds = new Set<string>();

    for (const child of directChildren) {
      const childParentKey = this.getHistoryParentKey(child);
      if (nextVisitedParentKeys.has(childParentKey)) {
        continue;
      }
      this.pushUniqueHistoryEntry(descendants, child, seenEntryIds);
      const nestedChildren = this.collectHistoryDescendants(
        childParentKey,
        source,
        nextVisitedParentKeys
      );
      for (const nestedChild of nestedChildren) {
        this.pushUniqueHistoryEntry(descendants, nestedChild, seenEntryIds);
      }
    }

    return descendants;
  }

  private pushUniqueHistoryEntry(
    entries: ConversationHistoryEntry[],
    entry: ConversationHistoryEntry,
    seenEntryIds: Set<string>
  ): void {
    if (seenEntryIds.has(entry.id)) {
      return;
    }
    seenEntryIds.add(entry.id);
    entries.push(entry);
  }

  private getHistoryParentKey(entry: Pick<ConversationHistoryEntry, 'originalInstanceId' | 'id'>): string {
    return entry.originalInstanceId.trim() || entry.id;
  }

  private getHistoryCollapseKey(entry: Pick<ConversationHistoryEntry, 'id'>): string {
    return `history:${entry.id}`;
  }
}
