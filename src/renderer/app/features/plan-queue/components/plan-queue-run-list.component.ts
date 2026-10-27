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

/** An account's display name by provider and id; unknown ids are shown as they are. */
export type PlanQueueAccountLabel = (provider: string, accountId: string) => string;

function describeRouteChoice(choice: PlanQueueRouteChoice, accountLabel: PlanQueueAccountLabel): string {
  const accounts = choice.accountProfileIds?.length
    ? ` (accounts: ${choice.accountProfileIds.map((id) => accountLabel(choice.provider, id)).join(', ')})` : '';
  const copilot = choice.copilotProfileId ? ` (account: ${accountLabel('copilot', choice.copilotProfileId)})` : '';
  return `${choice.provider}${choice.model ? `/${choice.model}` : ''}${accounts}${copilot}`;
}

/**
 * "Workers: claude/haiku (accounts: Work, Spare), then codex · Checkers: automatic · If stuck: claude/opus":
 * the current provider choices, in order. The last part shows only when a step-up choice is set.
 */
export function planQueueRoutingSummary(
  routing: PlanQueueRouting,
  options: { noWorkers?: string; accountLabel?: PlanQueueAccountLabel | null } = {},
): string {
  const label = options.accountLabel ?? ((_provider: string, id: string) => id);
  const describe = (choice: PlanQueueRouteChoice) => describeRouteChoice(choice, label);
  const workers = routing.workers.length > 0 ? routing.workers.map(describe).join(', then ') : options.noWorkers ?? 'default provider';
  const checkers = routing.verifiers.length > 0 ? routing.verifiers.map(describe).join(', ') : 'automatic';
  return `Workers: ${workers} · Checkers: ${checkers}${routing.stepUp ? ` · If stuck: ${describe(routing.stepUp)}` : ''}`;
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
  /** Account display names for the summaries; ids are shown until they load. */
  accountLabel = input<PlanQueueAccountLabel | null>(null);

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
  protected routingSummary(routing: PlanQueueRouting): string {
    return planQueueRoutingSummary(routing, { accountLabel: this.accountLabel() });
  }
}
