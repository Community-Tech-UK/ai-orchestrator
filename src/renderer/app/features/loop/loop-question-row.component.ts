import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { LoopOutstandingItemPayload, LoopAnswerOutstandingPayload } from '@contracts/schemas/loop';
import { loopQuestionNeed, loopQuestionLabel } from '../../../../shared/attention/question-need';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import type { QuestionDelivery } from './loop-questions.store';

@Component({
  selector: 'app-loop-question-row', standalone: true, imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './loop-question-row.component.html', styleUrl: './loop-question-row.component.scss',
})
export class LoopQuestionRowComponent {
  readonly item = input.required<LoopOutstandingItemPayload>();
  readonly busy = input(false);
  readonly delivery = input<QuestionDelivery | null>(null);
  readonly answerRequested = output<LoopAnswerOutstandingPayload>();
  private readonly draft = signal<string | null>(null);
  protected readonly need = computed(() => loopQuestionNeed(this.item()));
  protected readonly label = computed(() => loopQuestionLabel(this.need()));
  protected readonly answerText = computed(() => this.draft() ?? this.item().userResponse ?? (this.need() === 'applied' ? '' : this.item().recommendedAnswer ?? ''));
  protected readonly deliveryText = computed(() => {
    const delivery = this.delivery() ?? (this.item().answerSentAt ? 'sent-to-loop' : this.item().userResponse ? 'saved-for-resume' : null);
    return delivery === 'sent-to-loop' ? 'Sent. The loop reads it at the start of its next round.' : delivery === 'saved-for-resume' ? 'Saved. It goes into the next run when you choose Resume with answers.' : delivery === 'recorded' ? 'Recorded.' : '';
  });
  protected readonly copy = copyFor;
  protected edit(event: Event): void { this.draft.set((event.target as HTMLTextAreaElement).value); }
  protected act(action: LoopAnswerOutstandingPayload['action']): void {
    this.answerRequested.emit({ id: this.item().id, action, expectedRecommendation: this.item().recommendedAnswer ?? null, ...((action === 'answer' || action === 'undo') ? { response: this.answerText() } : {}) });
  }
}
