import { Injectable, inject } from '@angular/core';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import type { Instance } from '../../core/state/instance.store';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { HierarchicalInstance } from './instance-list.component';

interface ProjectStateSummary {
  projectStateLabel: string;
  projectStateTone: 'working' | 'attention' | 'connecting' | 'ready' | 'history';
}

@Injectable({ providedIn: 'root' })
export class ProjectGroupComputationService {
  private newSessionDraft = inject(NewSessionDraftService);

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
      childrenByParent: Map<string, string[]>;
      instanceMap: Map<string, Instance>;
      activityCutoff: number | null;
    },
    depth: number,
    parentChain: boolean[],
    isLastChild: boolean
  ): HierarchicalInstance[] {
    if (this.isSupersededEditSourceWithReplacement(instance, context.instanceMap)) {
      return [];
    }

    const childrenIds = context.childrenByParent.get(instance.id) ?? [];
    const children = childrenIds
      .map((childId) => context.instanceMap.get(childId))
      .filter((child): child is Instance => child !== undefined)
      .sort((left, right) => left.createdAt - right.createdAt);

    const childParentChain = parentChain.concat(!isLastChild);
    const visibleChildren = children.flatMap((child, index) =>
      this.buildVisibleItems(
        child,
        context,
        depth + 1,
        childParentChain,
        index === children.length - 1
      )
    );

    const textMatches = !context.filter ||
      context.projectMatches ||
      this.matchesInstanceText(instance, context.filter);
    const statusMatches = context.status === 'all' || instance.status === context.status;
    const locationMatches =
      context.location === 'all' ||
      (context.location === 'remote' && instance.executionLocation?.type === 'remote') ||
      (context.location === 'local' && (instance.executionLocation === undefined || instance.executionLocation.type === 'local'));
    const activityMatches =
      context.activityCutoff === null ||
      Math.max(instance.lastActivity, instance.createdAt) >= context.activityCutoff;
    const selfVisible = textMatches && statusMatches && locationMatches && activityMatches;

    if (!selfVisible && visibleChildren.length === 0) {
      return [];
    }

    const hasChildren = children.length > 0;
    const isExpanded = !context.collapsed.has(instance.id);
    const currentItem: HierarchicalInstance = {
      instance: {
        ...instance,
        childrenIds,
      },
      railTitle: instance.displayName,
      depth,
      hasChildren,
      isExpanded,
      isLastChild,
      parentChain,
    };

    if (!hasChildren || !isExpanded) {
      return [currentItem];
    }

    return [currentItem, ...visibleChildren];
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
}
