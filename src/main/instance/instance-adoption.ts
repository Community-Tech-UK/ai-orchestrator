/**
 * Adopt a live session that has lost its parent as a child of another live
 * session.
 *
 * Children normally get their parent at creation. A Plan Queue run can only
 * name its parent once that session exists, and after an app restart the
 * parent comes back later, under a new id (history restore), than the
 * workers recovery respawns. Adoption gives those workers the same parent
 * links creation would have: the instance pair and depth, the supervisor
 * tree, the orchestration registry, and the renderer (via the next state
 * update).
 *
 * A session has lost its parent when it has none, its parent is gone, or its
 * parent was superseded by an edit-and-resend (the source stays in memory,
 * hidden, while its replacement carries the conversation). A child of a
 * working parent is never taken from it.
 */

import type { Instance } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import { getSupervisorTree } from '../process';

const logger = getLogger('InstanceAdoption');

export interface InstanceAdoptionDeps {
  getInstance(instanceId: string): Instance | undefined;
  reparentOrchestration(instanceId: string, parentId: string): void;
  /** Re-broadcast the child; the state update carries its live parentId. */
  queueUpdate(instance: Instance): void;
}

export function adoptInstance(deps: InstanceAdoptionDeps, childId: string, parentId: string): boolean {
  const child = deps.getInstance(childId);
  const parent = deps.getInstance(parentId);
  if (!child || !parent || childId === parentId || child.parentId === parentId) return false;
  const previous = child.parentId ? deps.getInstance(child.parentId) : undefined;
  if (previous && previous.status !== 'superseded') return false;
  if (isAncestor(deps, childId, parent)) return false;

  if (previous) previous.childrenIds = previous.childrenIds.filter((id) => id !== childId);
  child.parentId = parentId;
  shiftSubtreeDepth(deps, child, parent.depth + 1 - child.depth);
  if (!parent.childrenIds.includes(childId)) parent.childrenIds.push(childId);
  getSupervisorTree().reparentInstance(childId, parentId);
  deps.reparentOrchestration(childId, parentId);
  deps.queueUpdate(child);
  logger.info('Adopted instance that lost its parent', { instanceId: childId, parentId, previousParentId: previous?.id });
  return true;
}

/** The adopted session and its own children move down the tree together. */
function shiftSubtreeDepth(deps: InstanceAdoptionDeps, root: Instance, shift: number): void {
  const pending = [root];
  const seen = new Set<string>();
  for (let instance = pending.pop(); instance; instance = pending.pop()) {
    if (seen.has(instance.id)) continue;
    seen.add(instance.id);
    instance.depth += shift;
    for (const childId of instance.childrenIds) {
      const child = deps.getInstance(childId);
      if (child) pending.push(child);
    }
  }
}

/** True when `ancestorId` is `instance` or one of its ancestors (adopting would make a cycle). */
function isAncestor(deps: InstanceAdoptionDeps, ancestorId: string, instance: Instance): boolean {
  const seen = new Set<string>();
  let current: Instance | undefined = instance;
  while (current && !seen.has(current.id)) {
    if (current.id === ancestorId) return true;
    seen.add(current.id);
    current = current.parentId ? deps.getInstance(current.parentId) : undefined;
  }
  return false;
}
