import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
import { buildHudSnapshot } from '../../../../shared/utils/orchestration-hud-builder';
import type { HudQuickAction } from '../../../../shared/types/orchestration-hud.types';
import { toHudChildInput } from './orchestration-instance-adapter';

@Component({
  selector: 'app-orchestration-hud',
  standalone: true,
  templateUrl: './orchestration-hud.component.html',
  styleUrl: './orchestration-hud.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrchestrationHudComponent {
  private store = inject(InstanceStore);
  private destroyRef = inject(DestroyRef);
  private now = signal(Date.now());

  parentInstanceId = input.required<string>();
  quickAction = output<HudQuickAction>();
  isCollapsed = signal(false);

  snapshot = computed(() => {
    const now = this.now();
    const instances = this.store.instancesMap();
    const parentId = this.parentInstanceId();
    const parent = instances.get(parentId);
    const activities = this.store.instanceActivities();
    const children = (parent?.childrenIds ?? [])
      .map((childId) => instances.get(childId))
      .filter((child) => child !== undefined)
      .map((child) => toHudChildInput(child, activities.get(child.id)));

    return buildHudSnapshot(parentId, children, { now });
  });

  constructor() {
    const interval = setInterval(() => this.now.set(Date.now()), 5_000);
    this.destroyRef.onDestroy(() => clearInterval(interval));
  }

  toggleCollapsed(): void {
    this.isCollapsed.update((value) => !value);
  }

  emitAction(action: HudQuickAction): void {
    this.quickAction.emit(action);
  }
}
