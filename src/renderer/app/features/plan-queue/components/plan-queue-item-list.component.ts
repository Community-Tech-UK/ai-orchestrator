import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type {
  PlanQueueItemDto,
  PlanQueueItemState,
  PlanQueueParkReason,
  PlanQueueVerdict,
} from '@contracts/schemas/plan-queue';
import { PlanQueueQuestionCardComponent } from './plan-queue-question-card.component';

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
  'round-limit': 'Hit the round limit',
  'verifier-unreliable': 'Verifier was unreliable',
  'no-diverse-verifier': 'No sufficiently diverse verifier available',
  'worker-error': 'Worker error',
  'worktree-error': 'Worktree error',
  'merge-conflict': 'Merge conflict',
  'land-blocked': 'Landing blocked',
  'provider-limit': 'Provider rate limit',
  cancelled: 'Cancelled',
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
 * detail when present. Renders the triage/verifier question inline for any
 * item in `needs-answer`.
 */
@Component({
  selector: 'app-plan-queue-item-list',
  standalone: true,
  imports: [PlanQueueQuestionCardComponent],
  templateUrl: './plan-queue-item-list.component.html',
  styleUrl: './plan-queue-item-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueItemListComponent {
  items = input<PlanQueueItemDto[]>([]);

  answer = output<{ itemId: string; optionId: string }>();
  skipItem = output<string>();

  protected readonly documentBasename = planQueueDocumentBasename;
  protected readonly stateLabel = planQueueStateLabel;
  protected readonly parkReasonLabel = planQueueParkReasonLabel;
  protected readonly verdictSummary = planQueueVerdictSummary;

  /** Readiness questions (needs-answer) and a waiting worker's question (working / fixing). */
  hasOpenQuestion(state: PlanQueueItemState): boolean {
    return state === 'needs-answer' || state === 'working' || state === 'fixing';
  }

  isSkippable(state: PlanQueueItemState): boolean {
    return SKIPPABLE_STATES.has(state);
  }

  onAnswer(itemId: string, optionId: string): void {
    this.answer.emit({ itemId, optionId });
  }

  onSkip(itemId: string): void {
    this.skipItem.emit(itemId);
  }
}
