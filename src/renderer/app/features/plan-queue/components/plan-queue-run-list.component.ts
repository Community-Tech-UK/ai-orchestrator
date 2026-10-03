import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { PlanQueueItemDto, PlanQueueItemState, PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { PlanQueueItemListComponent, planQueueStateLabel } from './plan-queue-item-list.component';
import { PlanQueueRunControlsComponent } from './plan-queue-run-controls.component';

/**
 * Summary order: what needs James, then work in flight, then outcomes. A Record,
 * so a new item state cannot be left out of the counts silently.
 */
const SUMMARY_STATE_RANK: Record<PlanQueueItemState, number> = {
  'needs-answer': 0,
  discovered: 1,
  queued: 2,
  preparing: 3,
  working: 4,
  fixing: 5,
  'awaiting-slot': 6,
  verifying: 7,
  landing: 8,
  landed: 9,
  parked: 10,
  skipped: 11,
};
const SUMMARY_STATE_ORDER = (Object.keys(SUMMARY_STATE_RANK) as PlanQueueItemState[])
  .sort((a, b) => SUMMARY_STATE_RANK[a] - SUMMARY_STATE_RANK[b]);

function formatStartedAt(startedAt: number): string {
  return new Date(startedAt).toLocaleString();
}

/** "5 Landed, 38 Needs your answer, 19 Parked": one run's documents counted by state. */
export function planQueueStateCounts(items: readonly PlanQueueItemDto[]): string {
  return SUMMARY_STATE_ORDER
    .map((state) => [state, items.filter((item) => item.state === state).length] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${planQueueStateLabel(state)}`)
    .join(', ');
}

/**
 * Every loaded run with its controls always in view. Each run's document list
 * is collapsed behind a state-count summary so that many runs, or one large run,
 * never push the other runs' Pause/Resume/Cancel controls out of reach.
 */
@Component({
  selector: 'app-plan-queue-run-list',
  standalone: true,
  imports: [PlanQueueItemListComponent, PlanQueueRunControlsComponent],
  templateUrl: './plan-queue-run-list.component.html',
  styleUrl: './plan-queue-run-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueRunListComponent {
  runs = input<PlanQueueRunDto[]>([]);

  pauseRun = output<string>();
  resumeRun = output<string>();
  cancelRun = output<string>();
  skipItem = output<string>();

  protected readonly formatStartedAt = formatStartedAt;
  protected readonly stateCounts = planQueueStateCounts;
}
