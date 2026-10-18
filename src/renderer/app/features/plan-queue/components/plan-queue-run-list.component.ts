import { queueRunSpendLabel } from './plan-queue-spend-label';
import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import type {
  PlanQueueItemDto,
  PlanQueueItemState,
  PlanQueueRouteChoice,
  PlanQueueRouting,
  PlanQueueRunDto,
} from '@contracts/schemas/plan-queue';
import { PlanQueueItemListComponent, planQueueStateLabel } from './plan-queue-item-list.component';
import { PlanQueueRoutingPanelComponent } from './plan-queue-routing-panel.component';
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
  const heldCount = items.filter(item => item.heldAt != null).length;
  const states = SUMMARY_STATE_ORDER
    .map((state) => [state, items.filter((item) => item.state === state && item.heldAt == null).length] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${planQueueStateLabel(state)}`)
    .join(', ');
  return [heldCount ? `${heldCount} Paused` : '', states].filter(Boolean).join(', ');
}

function describeRouteChoice(choice: PlanQueueRouteChoice): string {
  const accounts = choice.accountProfileIds?.length ? ` (accounts: ${choice.accountProfileIds.join(', ')})` : '';
  const copilot = choice.copilotProfileId ? ` (account: ${choice.copilotProfileId})` : '';
  return `${choice.provider}${choice.model ? `/${choice.model}` : ''}${accounts}${copilot}`;
}

/** "Workers: claude/opus (accounts: a, b) · Checkers: automatic": the run's current provider choices. */
export function planQueueRoutingSummary(routing: PlanQueueRouting): string {
  const workers = routing.worker ? describeRouteChoice(routing.worker) : 'default provider';
  const checkers = routing.verifiers.length > 0 ? routing.verifiers.map(describeRouteChoice).join(', ') : 'automatic';
  return `Workers: ${workers} · Checkers: ${checkers}`;
}

/**
 * Every loaded run with its controls always in view. Each run's document list
 * is collapsed behind a state-count summary so that many runs, or one large run,
 * never push the other runs' Pause/Resume/Cancel controls out of reach.
 */
@Component({
  selector: 'app-plan-queue-run-list',
  standalone: true,
  imports: [PlanQueueItemListComponent, PlanQueueRunControlsComponent, PlanQueueRoutingPanelComponent],
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

  protected readonly editingRun = signal<string | null>(null);

  canChange(run: PlanQueueRunDto): boolean {
    return run.status === 'running' || run.status === 'paused'
      || (['completed', 'cancelled'].includes(run.status) && run.items.some(item => item.state === 'parked'));
  }

  protected readonly spendLabel = queueRunSpendLabel;
  protected readonly formatStartedAt = formatStartedAt;
  protected readonly stateCounts = planQueueStateCounts;
  protected readonly routingSummary = planQueueRoutingSummary;
}
