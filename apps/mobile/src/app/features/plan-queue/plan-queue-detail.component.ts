import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { waitsForDirectChangeChoice, type MobilePlanQueueDirectChangeChoice } from '../../core/models';
import { PlanQueueStore } from './plan-queue.store';

/** Each direct-change choice's button label, and the label while it is being sent. */
const CHOICE_LABELS: Record<MobilePlanQueueDirectChangeChoice, readonly [string, string]> = {
  'keep-change': ['Keep that change', 'Keeping that change…'],
  'take-job-version': ["Take the job's version", "Taking the job's version…"],
};

@Component({
  standalone: true,
  selector: 'app-plan-queue-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobileHeaderComponent, MobileIconComponent],
  template: `
    <section class="screen">
      <app-mobile-header [title]="queue.item(id())?.title || 'Plan'">
        <button mobileHeaderLeading class="mobile-icon-button" type="button" (click)="back()" aria-label="Back to plan queue">
          <app-mobile-icon name="chevron-left" />
        </button>
      </app-mobile-header>
      @if (queue.item(id()); as item) {
        <p>{{ item.state }} · round {{ item.round }}</p>
        @if (item.detail) { <p>{{ item.detail }}</p> }
        @if (item.question; as question) {
          <h2>{{ question.question }}</h2>
          @for (option of question.options; track option.id) {
            <button type="button" [disabled]="queue.pending()" (click)="answer(option.id)">{{ option.label }}</button>
          }
        }
        @if (waitsForDirectChangeChoice(item)) {
          <h2>Choose which version to keep</h2>
          <button type="button" [disabled]="queue.pending()" aria-describedby="keep-change-effect"
            (click)="chooseDirectChange('keep-change')">{{ choiceLabel('keep-change') }}</button>
          <p id="keep-change-effect" class="effect">The job runs again and puts that change back.</p>
          <button type="button" [disabled]="queue.pending()" aria-describedby="take-job-effect"
            (click)="chooseDirectChange('take-job-version')">{{ choiceLabel('take-job-version') }}</button>
          <p id="take-job-effect" class="effect">The job is merged as it is, which undoes that change.</p>
        }
        @if (queue.diffstat()) { <pre>{{ queue.diffstat() }}</pre> }
        @if (queue.error(); as message) { <p role="alert">{{ message }}</p> }
      } @else {
        <p role="status">This plan is no longer in the queue.</p>
      }
    </section>
  `,
  styles: [`
    :host { position: fixed; inset: 0; display: flex; background: var(--bg); color: var(--text);
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
    .screen { display: flex; flex-direction: column; gap: var(--space-3); padding-inline: var(--mobile-gutter); flex: 1; overflow: auto; }
    button { min-height: var(--control-size); text-align: start; border: 0; border-radius: var(--radius-md); background: var(--surface); color: inherit; padding: var(--space-3); }
    pre { white-space: pre-wrap; }
    .effect { margin-block-start: calc(-1 * var(--space-2)); color: var(--text-secondary); }
  `],
})
export class PlanQueueDetailComponent {
  readonly id = input.required<string>();
  protected readonly queue = inject(PlanQueueStore);
  private readonly router = inject(Router);

  constructor() {
    effect(() => { void this.queue.loadDiffstat(this.id()); });
  }

  protected back(): void { void this.router.navigate(['/plan-queue']); }
  protected answer(optionId: string): void { void this.queue.answer(this.id(), optionId); }
  protected readonly waitsForDirectChangeChoice = waitsForDirectChangeChoice;
  private readonly sending = signal<MobilePlanQueueDirectChangeChoice | null>(null);
  protected choiceLabel(choice: MobilePlanQueueDirectChangeChoice): string {
    return CHOICE_LABELS[choice][this.sending() === choice ? 1 : 0];
  }
  protected async chooseDirectChange(choice: MobilePlanQueueDirectChangeChoice): Promise<void> {
    this.sending.set(choice);
    try { await this.queue.chooseDirectChange(this.id(), choice); } finally { this.sending.set(null); }
  }
}
