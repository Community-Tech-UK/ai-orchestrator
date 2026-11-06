import { planQueueDisplayParkReason } from '../plan-queue-park-reason-help';
import { isNotReachedItem, PLAN_QUEUE_NOT_REACHED_LABEL } from '../../../../../shared/utils/plan-queue-item-outcome';
import { foldDetail, planQueueCheckGroupLabel, pluralise } from '../../../../../shared/utils/plan-queue-item-display';
import { copyFor } from '../../../shared/tooltip/tooltip-copy';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';
import { queueItemSpendLabel } from './plan-queue-spend-label';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { PLAN_QUEUE_STAGE_TICK_MS, planQueueStageLine } from '../../../../../shared/utils/plan-queue-stage-text';
import type {
  PlanQueueItemDto,
  PlanQueueItemState,
  PlanQueueRouteChoice,
  PlanQueueVerdict,
} from '@contracts/schemas/plan-queue';

const STATE_LABELS: Record<PlanQueueItemState, string> = {
  discovered: 'Discovered',
  'needs-answer': 'Needs your answer',
  queued: 'Queued',
  preparing: 'Preparing',
  working: 'Working',
  fixing: 'Fixing findings',
  'awaiting-slot': 'Awaiting a slot',
  verifying: 'Verifying',
  landing: 'Merging',
  landed: 'Merged',
  parked: 'Set aside',
  skipped: 'Skipped',
};

/**
 * Only an item that has not started can be skipped (the coordinator refuses the
 * rest); in-flight work is stopped by cancelling the run, which parks it safely.
 */
const SKIPPABLE_STATES: ReadonlySet<PlanQueueItemState> = new Set<PlanQueueItemState>([
  'discovered',
  'needs-answer',
  'queued',
]);

export function planQueueDocumentBasename(documentPath: string): string {
  const parts = documentPath.split('/');
  return parts[parts.length - 1] || documentPath;
}

export function planQueueStateLabel(state: PlanQueueItemState): string {
  return STATE_LABELS[state] ?? state;
}

export function planQueueVerdictSummary(verdict: PlanQueueVerdict | null): string {
  if (!verdict) return '';
  const label = verdict.verdict === 'PASS' ? 'Passed' : 'Changes needed';
  if (verdict.findings.length === 0) return `${label} — no findings`;
  const counts = new Map<string, number>();
  for (const finding of verdict.findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  const parts = Array.from(counts, ([severity, count]) => `${count} ${severity}`).join(', ');
  return `${label} — ${parts}`;
}

/**
 * One run's items: document, current state, round/error counts, a verdict
 * summary once the verifier has judged it, and the park reason and free-text
 * detail when present, and whether it was handed to the stronger worker. An item with an open question only points to it: the
 * question cards themselves live in the page's "Needs your answer" section.
 */
@Component({
  selector: 'app-plan-queue-item-list',
  standalone: true,
  imports: [AioTooltipDirective],
  templateUrl: './plan-queue-item-list.component.html',
  styleUrl: './plan-queue-item-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueItemListComponent {
  /** Moves the shown step times on while the page is open. */
  private readonly now = signal(Date.now());
  protected readonly copy = copyFor;
  items = input<PlanQueueItemDto[]>([]);
  maxRounds = input.required<number>();
  /** The run's step-up choice, named on a document that was handed to it. */
  stepUp = input<PlanQueueRouteChoice | null>(null);
  protected readonly confirmingSkip = signal<string | null>(null);
  /** A handover happens only when the rounds run out, so its failed checks are the run's round limit. */
  protected readonly steppedUpLabel = computed(() => {
    const choice = this.stepUp();
    const named = choice ? ` (${choice.provider}${choice.model ? ` / ${choice.model}` : ''})` : '';
    return `Handed to a stronger worker${named} after ${pluralise(this.maxRounds(), 'failed check')}`;
  });

  skipItem = output<string>();

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), PLAN_QUEUE_STAGE_TICK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected readonly spendLabel = queueItemSpendLabel;
  protected readonly documentBasename = planQueueDocumentBasename;
  protected readonly stateLabel = planQueueStateLabel;
  protected readonly isNotReached = isNotReachedItem;
  protected readonly notReachedLabel = PLAN_QUEUE_NOT_REACHED_LABEL;
  protected readonly verdictSummary = planQueueVerdictSummary;
  protected readonly parkHelp = planQueueDisplayParkReason;
  protected readonly foldedDetail = foldDetail;
  protected readonly checkGroupLabel = planQueueCheckGroupLabel;
  protected readonly pluralise = pluralise;

  /** The same live line the session list shows while Harness checks or lands this job, or it waits for that. */
  stageText(item: PlanQueueItemDto): string | null {
    return planQueueStageLine(item, this.now())?.text ?? null;
  }

  /** Readiness questions (needs-answer) and a waiting worker's question (working / fixing). */
  hasOpenQuestion(state: PlanQueueItemState): boolean {
    return state === 'needs-answer' || state === 'working' || state === 'fixing';
  }

  isSkippable(item: PlanQueueItemDto): boolean {
    return SKIPPABLE_STATES.has(item.state) && item.heldAt == null && item.branchName === null && item.worktreePath === null;
  }

  onSkip(itemId: string): void {
    this.confirmingSkip.set(itemId);
  }

  cancelSkip(): void {
    this.confirmingSkip.set(null);
  }

  confirmSkip(itemId: string): void {
    if (this.confirmingSkip() !== itemId) return;
    this.confirmingSkip.set(null);
    if (this.items().some(item => item.id === itemId && this.isSkippable(item))) {
      this.skipItem.emit(itemId);
    }
  }
}
