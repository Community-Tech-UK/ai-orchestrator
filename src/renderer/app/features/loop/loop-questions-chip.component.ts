import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { LoopQuestionsStore } from './loop-questions.store';
import { LoopQuestionRowComponent } from './loop-question-row.component';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';

@Component({
  selector: 'app-loop-questions-chip', standalone: true, imports: [LoopQuestionRowComponent, AioTooltipDirective], providers: [LoopQuestionsStore], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (questions.waitingCount() || questions.appliedCount()) {
      <button type="button" [attr.aria-expanded]="expanded()" (click)="expanded.update(toggle)" [appTooltip]="copy('loop.question.chip')">{{ questions.waitingCount() }} questions for you · {{ questions.appliedCount() }} decisions to check</button>
    }
    @if (expanded()) {
      <div role="list">@for (item of questions.items(); track item.id) { <app-loop-question-row [item]="item" [busy]="questions.pendingId() === item.id" [delivery]="questions.deliveryFor(item.id)" (answerRequested)="questions.answer($event.id, $event.action, $event.response, $event.expectedRecommendation)" /> }</div>
    }
    @if (questions.error()) { <p role="alert">{{ questions.error() }}</p> }
  `,
})
export class LoopQuestionsChipComponent {
  readonly loopRunId = input.required<string>();
  readonly chatId = input.required<string>();
  protected readonly questions = inject(LoopQuestionsStore);
  protected readonly expanded = signal(false);
  protected readonly toggle = (value: boolean) => !value;
  protected readonly copy = copyFor;
  constructor() { effect(() => { const id = this.loopRunId(); const chat = this.chatId(); untracked(() => { void this.questions.load(id, chat); }); }); }
}
