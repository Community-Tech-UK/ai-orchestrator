import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { PlanQueueItemListComponent } from './plan-queue-item-list.component';
import { PlanQueueRunControlsComponent } from './plan-queue-run-controls.component';

function formatStartedAt(startedAt: number): string {
  return new Date(startedAt).toLocaleString();
}

/**
 * Every loaded run, each with its own controls and item list. The heaviest
 * pane in the panel, so it stays a thin composition of `RunControls` and
 * `ItemList` rather than owning any of their rendering itself.
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
  answer = output<{ itemId: string; optionId: string }>();
  skipItem = output<string>();

  protected readonly formatStartedAt = formatStartedAt;
}
