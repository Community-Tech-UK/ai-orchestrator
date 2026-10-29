import { copyFor } from '../../../shared/tooltip/tooltip-copy';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { PlanQueueAlert } from '@contracts/schemas/plan-queue';

const ALERT_LABELS: Record<PlanQueueAlert['kind'], string> = {
  'unowned-worktree': 'Unowned worktree',
  'missing-worktree': 'Missing worktree',
  'invalid-worktree': 'Invalid worktree',
  'unowned-branch': 'Unowned branch',
};

export function planQueueAlertLabel(kind: PlanQueueAlert['kind']): string {
  return ALERT_LABELS[kind] ?? kind;
}

/**
 * Worktree reconciler findings: missing/invalid owned checkouts and unowned
 * worktrees or branches. Re-runs on demand — the
 * coordinator does not push these on every change.
 */
@Component({
  selector: 'app-plan-queue-alerts-list',
  standalone: true,
  imports: [AioTooltipDirective],
  templateUrl: './plan-queue-alerts-list.component.html',
  styleUrl: './plan-queue-alerts-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueAlertsListComponent {
  protected readonly copy = copyFor;
  alerts = input<PlanQueueAlert[]>([]);
  refresh = output<void>();

  protected readonly alertLabel = planQueueAlertLabel;

  onRefresh(): void {
    this.refresh.emit();
  }
}
