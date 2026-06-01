import type { Instance } from '../../core/state/instance.store';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type {
  HierarchicalHistoryItem,
  HierarchicalInstance,
  HierarchicalRailItem,
  ProjectGroup,
} from './instance-list.types';

export function flattenLiveItems(items: readonly HierarchicalInstance[]): HierarchicalInstance[] {
  return items.flatMap((item) => [
    item,
    ...flattenRailChildren(item.children).filter(
      (child): child is HierarchicalInstance => child.kind === 'live',
    ),
  ]);
}

export function flattenRailChildren(items: readonly HierarchicalRailItem[]): HierarchicalRailItem[] {
  return items.flatMap((item) => [item, ...flattenRailChildren(item.children)]);
}

export function flattenHistoryNodes(items: readonly HierarchicalHistoryItem[]): ConversationHistoryEntry[] {
  return items.flatMap((item) => [item.entry, ...flattenHistoryNodes(item.children)]);
}

export function getAllProjectHistoryItems(group: ProjectGroup): ConversationHistoryEntry[] {
  const items = [
    ...flattenHistoryNodes(group.historyItems),
    ...flattenRailChildren(group.liveItems.flatMap((item) => item.children))
      .filter((item): item is HierarchicalHistoryItem => item.kind === 'history')
      .map((item) => item.entry),
  ];
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

export function getOrderedRootInstances(
  instances: Instance[],
  rootInstanceOrder: readonly string[],
): Instance[] {
  const orderedRootIds = getOrderedRootIds(instances, rootInstanceOrder);
  const instanceMap = new Map(instances.map((instance) => [instance.id, instance]));
  return orderedRootIds
    .map((id) => instanceMap.get(id))
    .filter((instance): instance is Instance => !!instance);
}

export function getOrderedOrphanedChildInstances(
  instances: Instance[],
  instanceMap: ReadonlyMap<string, Instance>,
): Instance[] {
  return instances
    .filter((instance) => !!instance.parentId && !instanceMap.has(instance.parentId))
    .sort((left, right) => left.createdAt - right.createdAt);
}

export function getOrderedRootIds(
  instances: Instance[],
  rootInstanceOrder: readonly string[],
): string[] {
  const roots = instances.filter((instance) => !instance.parentId);

  return [...roots]
    .sort((left, right) => {
      const leftIndex = rootInstanceOrder.indexOf(left.id);
      const rightIndex = rootInstanceOrder.indexOf(right.id);

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
