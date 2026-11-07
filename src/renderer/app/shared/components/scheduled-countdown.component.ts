import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';

@Component({ selector: 'app-scheduled-countdown', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `{{ label() }}`,
})
export class ScheduledCountdownComponent {
  readonly deadline = input<number | null>(null);
  readonly waitingForIdle = input(false);
  private readonly now = signal(Date.now());
  readonly label = computed(() => {
    const deadline = this.deadline();
    if (deadline === null || !Number.isFinite(deadline)) return 'Next run unverified';
    const remaining = deadline - this.now();
    if (remaining <= 0) return this.waitingForIdle() ? 'Due now, waiting for the session to be idle' : 'Due now';
    if (remaining < 60000) return `in ${Math.ceil(remaining / 1000)} s`;
    const minutes = Math.ceil(remaining / 60000);
    if (minutes < 60) return `in ${minutes} min`;
    const hours = Math.ceil(remaining / 3_600_000);
    if (hours < 24) return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
    const days = Math.ceil(remaining / 86_400_000);
    return `in ${days} ${days === 1 ? 'day' : 'days'}`;
  });
  constructor() {
    inject(DestroyRef).onDestroy(inject(RendererPollSchedulerService).register(() => { this.now.set(Date.now()); }, 1000));
  }
}
