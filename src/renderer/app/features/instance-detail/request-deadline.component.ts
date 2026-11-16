import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, signal } from '@angular/core';
import { formatRemaining } from '../../core/state/pending-approvals-banner.rules';

/** The time left to answer a request that has a deadline: "42s left", then "expiring…". */
@Component({
  selector: 'app-request-deadline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p class="deadline" role="timer">{{ remaining() }}</p>`,
  styles: `.deadline { margin: 0 0 var(--spacing-sm); color: var(--text-muted); font-size: 12px; }`,
})
export class RequestDeadlineComponent {
  readonly expiresAt = input.required<number>();
  private readonly now = signal(Date.now());

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected remaining(): string {
    return formatRemaining(this.expiresAt(), this.now());
  }
}
