import { ChangeDetectionStrategy, Component, effect, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { PlanQueueStore } from './plan-queue.store';

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
}
