/**
 * Instance Queries - Computed selectors for instance state
 *
 * All read-only computed values derived from instance state.
 */

import { Injectable, inject, computed } from '@angular/core';
import { InstanceStateService } from './instance-state.service';
import { ActivityDebouncerService } from '../../services/activity-debouncer.service';
import type { Instance, InstanceStatus } from './instance.types';

function activityStateToLabel(activityState: Instance['activityState']): string {
  switch (activityState) {
    case 'active':
      return 'Agent active';
    case 'waiting_input':
      return 'Waiting for input';
    case 'blocked':
      return 'Blocked';
    case 'exited':
      return 'Process exited';
    default:
      return '';
  }
}

@Injectable({ providedIn: 'root' })
export class InstanceQueries {
  private stateService = inject(InstanceStateService);
  private activityDebouncer = inject(ActivityDebouncerService);

  // ============================================
  // Basic Selectors
  // ============================================

  /** All instances as array */
  readonly instances = computed(() =>
    Array.from(this.stateService.state().instances.values())
  );

  /** Instances as Map for direct lookup */
  readonly instancesMap = computed(() => this.stateService.state().instances);

  /** Selected instance ID */
  readonly selectedInstanceId = computed(() =>
    this.stateService.state().selectedInstanceId
  );

  /** Selected instance object */
  readonly selectedInstance = computed(() => {
    const state = this.stateService.state();
    const id = state.selectedInstanceId;
    const selected = id ? state.instances.get(id) || null : null;
    if (
      selected?.status === 'superseded'
      && selected.cancelledForEdit === true
      && selected.supersededBy
    ) {
      return state.instances.get(selected.supersededBy) || selected;
    }

    return selected;
  });

  /** Loading state */
  readonly loading = computed(() => this.stateService.state().loading);

  /** Error state */
  readonly error = computed(() => this.stateService.state().error);

  /** Instance count */
  readonly instanceCount = computed(() =>
    this.stateService.state().instances.size
  );

  // ============================================
  // Derived Selectors
  // ============================================

  /** Instances grouped by status */
  readonly instancesByStatus = computed(() => {
    const grouped = new Map<InstanceStatus, Instance[]>();
    for (const instance of this.instances()) {
      const list = grouped.get(instance.status) || [];
      list.push(instance);
      grouped.set(instance.status, list);
    }
    return grouped;
  });

  /** Total context usage across all instances */
  readonly totalContextUsage = computed(() => {
    let used = 0;
    let total = 0;
    let costEstimate = 0;
    for (const instance of this.instances()) {
      used += instance.contextUsage.used;
      total += instance.contextUsage.total;
      costEstimate += instance.contextUsage.costEstimate || 0;
    }
    return {
      used,
      total,
      // Cap at 100% - used can exceed total in long sessions due to context truncation
      percentage: total > 0 ? Math.min((used / total) * 100, 100) : 0,
      costEstimate: costEstimate > 0 ? costEstimate : undefined,
    };
  });

  /** Root instances (no parent) */
  readonly rootInstances = computed(() =>
    this.instances().filter((i) => !i.parentId)
  );

  // ============================================
  // Activity Selectors
  // ============================================

  /** Current debounced activity for selected instance */
  readonly selectedInstanceActivity = computed(() => {
    const id = this.stateService.state().selectedInstanceId;
    if (!id) return '';
    const activity = this.activityDebouncer.getActivity(id);
    if (activity) {
      return activity;
    }
    return activityStateToLabel(this.stateService.state().instances.get(id)?.activityState);
  });

  /** Activities map from debouncer (for child panels) */
  readonly instanceActivities = computed(() => {
    const merged = new Map(this.activityDebouncer.activities());
    for (const instance of this.instances()) {
      if (merged.has(instance.id)) {
        continue;
      }
      const fallbackActivity = activityStateToLabel(instance.activityState);
      if (fallbackActivity) {
        merged.set(instance.id, fallbackActivity);
      }
    }
    return merged;
  });

  // ============================================
  // Message Queue Selectors
  // ============================================

  /** Get queued message count for an instance (reactive) */
  getQueuedMessageCount(instanceId: string): number {
    return this.stateService.messageQueue().get(instanceId)?.length || 0;
  }

  /** Get message queue for an instance (reactive) */
  getMessageQueue(instanceId: string): { message: string; files?: File[] }[] {
    return this.stateService.messageQueue().get(instanceId) || [];
  }
}
