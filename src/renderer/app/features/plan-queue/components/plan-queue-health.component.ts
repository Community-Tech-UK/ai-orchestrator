import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { Router } from '@angular/router';
import type { PlanQueueHealth } from '@contracts/schemas/plan-queue';
import { describeQueueHealth } from '../../../../../shared/utils/plan-queue-health-lines';

/**
 * "Queue health": how well the queue has been landing work recently, in plain words. The wording comes from one
 * shared function, so `plan_queue_status` reports the same lines. Figures cover finished work in the last two weeks.
 */
@Component({
  selector: 'app-plan-queue-health',
  standalone: true,
  templateUrl: './plan-queue-health.component.html',
  styleUrl: './plan-queue-health.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueHealthComponent {
  readonly health = input<PlanQueueHealth | null>(null);
  readonly refresh = output<void>();
  private readonly router = inject(Router);
  protected readonly summary = computed(() => {
    const health = this.health();
    return health ? describeQueueHealth(health) : null;
  });

  /** Settings' Computers list, where the test machine can be paused or limited. */
  protected openComputers(): void {
    void this.router.navigate(['/settings'], { queryParams: { tab: 'remote-nodes' } });
  }
}
