import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import type { PlanQueueItemDto } from '@contracts/schemas/plan-queue';
import { PlanQueueStore } from '../../../core/state/plan-queue.store';
import { planQueueParkReasonLabel } from './plan-queue-item-list.component';

type ParkedAction = 'land-anyway' | 'discard-item';

/**
 * Parked items across every run, with their branch and a lazily-fetched
 * `git diff --shortstat`. Resume is reversible so it fires immediately; Land
 * anyway and Discard are one-way, so both require an explicit confirm click.
 */
@Component({
  selector: 'app-plan-queue-parked-list',
  standalone: true,
  imports: [],
  templateUrl: './plan-queue-parked-list.component.html',
  styleUrl: './plan-queue-parked-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueParkedListComponent {
  private readonly store = inject(PlanQueueStore);
  private readonly pendingFetch = new Set<string>();

  items = input<PlanQueueItemDto[]>([]);

  resumeItem = output<string>();
  landAnyway = output<string>();
  discardItem = output<string>();

  protected readonly parkReasonLabel = planQueueParkReasonLabel;
  protected readonly diffstats = signal<Record<string, string>>({});
  protected readonly confirming = signal<{ itemId: string; action: ParkedAction } | null>(null);

  constructor() {
    effect(() => {
      for (const item of this.items()) {
        if (this.diffstats()[item.id] !== undefined || this.pendingFetch.has(item.id)) continue;
        this.pendingFetch.add(item.id);
        void this.store.diffstat(item.id).then((diffstat) => {
          this.pendingFetch.delete(item.id);
          this.diffstats.update((map) => ({ ...map, [item.id]: diffstat }));
        });
      }
    });
  }

  diffstatFor(itemId: string): string {
    const cached = this.diffstats()[itemId];
    if (cached === undefined) return 'Loading diff…';
    return cached || 'No changes';
  }

  onResume(itemId: string): void {
    this.resumeItem.emit(itemId);
  }

  isConfirming(itemId: string, action: ParkedAction): boolean {
    const current = this.confirming();
    return current?.itemId === itemId && current.action === action;
  }

  requestConfirm(itemId: string, action: ParkedAction): void {
    this.confirming.set({ itemId, action });
  }

  cancelConfirm(): void {
    this.confirming.set(null);
  }

  confirmAction(itemId: string, action: ParkedAction): void {
    this.confirming.set(null);
    if (action === 'land-anyway') this.landAnyway.emit(itemId);
    else this.discardItem.emit(itemId);
  }
}
