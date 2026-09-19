import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { PlanQueueAlert } from '@contracts/schemas/plan-queue';

const ALERT_LABELS: Record<PlanQueueAlert['kind'], string> = {
  'unowned-worktree': 'Unowned worktree',
  'missing-worktree': 'Missing worktree',
  'unowned-branch': 'Unowned branch',
};

export function planQueueAlertLabel(kind: PlanQueueAlert['kind']): string {
  return ALERT_LABELS[kind] ?? kind;
}

/**
 * Worktree reconciler findings: worktrees or branches the coordinator no
 * longer recognises as belonging to a live item. Re-runs on demand — the
 * coordinator does not push these on every change.
 */
@Component({
  selector: 'app-plan-queue-alerts-list',
  standalone: true,
  imports: [],
  templateUrl: './plan-queue-alerts-list.component.html',
  styleUrl: './plan-queue-alerts-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueAlertsListComponent {
  alerts = input<PlanQueueAlert[]>([]);
  refresh = output<void>();

  protected readonly alertLabel = planQueueAlertLabel;

  onRefresh(): void {
    this.refresh.emit();
  }
}
