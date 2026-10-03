import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { PlanQueueQuestionGroup } from '../../../core/state/plan-queue.store';
import { planQueueDocumentBasename } from './plan-queue-item-list.component';
import { PlanQueueQuestionCardComponent } from './plan-queue-question-card.component';

/** Above this many open questions, each run's group starts folded. */
export const PLAN_QUEUE_QUESTIONS_OPEN_LIMIT = 10;

/**
 * Every open question across all runs, grouped by run and labelled with its
 * document, so the decisions waiting on James are in one place at the top of
 * the page instead of scattered through each run's document list. A handful of
 * questions shows open; a backlog starts folded per run, so the Runs section
 * and its controls stay a short scroll away. The choice is made once per run
 * group, so a later count change never opens or folds a group under James.
 */
@Component({
  selector: 'app-plan-queue-question-list',
  standalone: true,
  imports: [PlanQueueQuestionCardComponent],
  templateUrl: './plan-queue-question-list.component.html',
  styleUrl: './plan-queue-question-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueQuestionListComponent {
  groups = input<PlanQueueQuestionGroup[]>([]);

  answer = output<{ itemId: string; optionId: string }>();

  protected readonly documentBasename = planQueueDocumentBasename;
  private readonly startOpen = computed(() =>
    this.groups().reduce((total, group) => total + group.items.length, 0) <= PLAN_QUEUE_QUESTIONS_OPEN_LIMIT);
  private readonly initialOpen = new Map<string, boolean>();

  /** Fixed at a group's first render; the bound value never changes afterwards. */
  isInitiallyOpen(runId: string): boolean {
    let open = this.initialOpen.get(runId);
    if (open === undefined) {
      open = this.startOpen();
      this.initialOpen.set(runId, open);
    }
    return open;
  }

  onAnswer(itemId: string, optionId: string): void {
    this.answer.emit({ itemId, optionId });
  }
}
