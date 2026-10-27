import { queueItemSpendLabel } from './plan-queue-spend-label';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type {
  PlanQueueItemDto,
  PlanQueueItemState,
  PlanQueueParkReason,
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
  landing: 'Landing',
  landed: 'Landed',
  parked: 'Parked',
  skipped: 'Skipped',
};

const PARK_REASON_LABELS: Record<PlanQueueParkReason, string> = {
  'round-limit': 'Still failing after the last check',
  'verifier-unreliable': 'The checker kept failing',
  'no-diverse-verifier': 'No second model free to check it',
  'worker-error': 'The worker stopped with an error',
  'triage-failed': "Couldn't check if it's ready",
  'worktree-error': "Couldn't set up its working copy",
  'merge-conflict': 'Merge clash to resolve',
  'land-blocked': "Couldn't merge",
  'provider-limit': 'Usage limit reached',
  cancelled: 'Stopped',
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

export function planQueueParkReasonLabel(reason: PlanQueueParkReason | null): string {
  if (!reason) return '';
  return PARK_REASON_LABELS[reason] ?? reason;
}

export function planQueueVerdictSummary(verdict: PlanQueueVerdict | null): string {
  if (!verdict) return '';
  if (verdict.findings.length === 0) return `${verdict.verdict} — no findings`;
  const counts = new Map<string, number>();
  for (const finding of verdict.findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  const parts = Array.from(counts, ([severity, count]) => `${count} ${severity}`).join(', ');
  return `${verdict.verdict} — ${parts}`;
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
  imports: [],
  templateUrl: './plan-queue-item-list.component.html',
  styleUrl: './plan-queue-item-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueItemListComponent {
  items = input<PlanQueueItemDto[]>([]);
  maxRounds = input.required<number>();
  /** The run's step-up choice, named on a document that was handed to it. */
  stepUp = input<PlanQueueRouteChoice | null>(null);
  protected readonly confirmingSkip = signal<string | null>(null);
  /** A handover happens only when the rounds run out, so its failed checks are the run's round limit. */
  protected readonly steppedUpLabel = computed(() => {
    const choice = this.stepUp();
    const named = choice ? ` (${choice.provider}${choice.model ? ` / ${choice.model}` : ''})` : '';
    return `Handed to a stronger worker${named} after ${this.maxRounds()} failed check(s)`;
  });

  skipItem = output<string>();

  protected readonly spendLabel = queueItemSpendLabel;
  protected readonly documentBasename = planQueueDocumentBasename;
  protected readonly stateLabel = planQueueStateLabel;
  protected readonly parkReasonLabel = planQueueParkReasonLabel;
  protected readonly verdictSummary = planQueueVerdictSummary;

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
