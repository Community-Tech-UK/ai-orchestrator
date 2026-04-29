import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { InstanceStore } from '../state/instance.store';
import type { VisibleInstanceOrder } from '../../../../shared/types/prompt-history.types';

interface VisibleProjectGroupSource {
  key: string;
  isExpanded: boolean;
  liveItems: readonly {
    instance: {
      id: string;
    };
  }[];
}

const EMPTY_ORDER: VisibleInstanceOrder = {
  computedAt: 0,
  instanceIds: [],
  projectKeys: [],
};

@Injectable({ providedIn: 'root' })
export class VisibleInstanceResolver {
  private readonly instanceStore = inject(InstanceStore);
  private readonly projectGroupsSource = signal<Signal<readonly VisibleProjectGroupSource[]> | null>(null);

  readonly order = computed<VisibleInstanceOrder>(() => {
    const source = this.projectGroupsSource();
    if (!source) {
      return EMPTY_ORDER;
    }

    const instanceIds: string[] = [];
    const projectKeys: string[] = [];

    for (const group of source()) {
      if (!group.isExpanded) {
        continue;
      }
      for (const item of group.liveItems) {
        instanceIds.push(item.instance.id);
        projectKeys.push(group.key);
      }
    }

    return {
      computedAt: Date.now(),
      instanceIds,
      projectKeys,
    };
  });

  setProjectGroupsSource(source: Signal<readonly VisibleProjectGroupSource[]>): void {
    const current = this.projectGroupsSource();
    if (current && current !== source) {
      throw new Error('VisibleInstanceResolver: source already set; only one InstanceListComponent is supported');
    }
    this.projectGroupsSource.set(source);
  }

  clearProjectGroupsSourceForTesting(): void {
    this.projectGroupsSource.set(null);
  }

  getOrder(): VisibleInstanceOrder {
    return this.order();
  }

  getInstanceIdAt(slot: number): string | null {
    if (!Number.isInteger(slot) || slot < 1) {
      return null;
    }
    return this.order().instanceIds[slot - 1] ?? null;
  }

  selectVisibleInstance(slot: number): boolean {
    const instanceId = this.getInstanceIdAt(slot);
    if (!instanceId) {
      return false;
    }

    this.instanceStore.setSelectedInstance(instanceId);
    return true;
  }
}
