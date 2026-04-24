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
    },
    depth: number,
    parentChain: boolean[],
    isLastChild: boolean
  ): HierarchicalInstance[] {
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
      instance.displayName.toLowerCase().includes(context.filter) ||
      instance.id.toLowerCase().includes(context.filter);
    const statusMatches = context.status === 'all' || instance.status === context.status;
    const locationMatches =
      context.location === 'all' ||
      (context.location === 'remote' && instance.executionLocation?.type === 'remote') ||
      (context.location === 'local' && (instance.executionLocation === undefined || instance.executionLocation.type === 'local'));
    const selfVisible = textMatches && statusMatches && locationMatches;

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
    return title.toLowerCase().includes(filter) || subtitle.toLowerCase().includes(filter);
  }

  matchesHistoryText(entry: ConversationHistoryEntry, filter: string): boolean {
    return (
      entry.displayName.toLowerCase().includes(filter) ||
      entry.firstUserMessage.toLowerCase().includes(filter) ||
      entry.lastUserMessage.toLowerCase().includes(filter)
    );
  }
}
