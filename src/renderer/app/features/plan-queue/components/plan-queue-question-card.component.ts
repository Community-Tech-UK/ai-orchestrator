import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import type { PlanQueueQuestion } from '@contracts/schemas/plan-queue';

let nextGroupId = 0;

/**
 * A triage/verifier question raised for one Plan Queue item. Renders as radio
 * controls only — James picks an option, he never types an option id.
 */
@Component({
  selector: 'app-plan-queue-question-card',
  standalone: true,
  imports: [],
  templateUrl: './plan-queue-question-card.component.html',
  styleUrl: './plan-queue-question-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueQuestionCardComponent {
  question = input.required<PlanQueueQuestion>();
  submitAnswer = output<string>();

  /** Unique per rendered card so multiple question cards on one page never share a radio group. */
  protected readonly groupName = `pq-question-${nextGroupId++}`;
  protected readonly selectedOptionId = signal<string | null>(null);

  selectOption(optionId: string): void {
    this.selectedOptionId.set(optionId);
  }

  onSubmit(): void {
    const optionId = this.selectedOptionId();
    if (!optionId) return;
    this.submitAnswer.emit(optionId);
  }
}
