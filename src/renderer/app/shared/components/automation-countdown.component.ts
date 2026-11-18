import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { Automation } from '../../../../shared/types/automation.types';
import { AutomationStore } from '../../core/state/automation.store';
import { InstanceStore } from '../../core/state/instance.store';
import { THREAD_WAKEUP_DEFERRED_BUSY } from '../../../../shared/utils/thread-wakeup-deferral';
import { ScheduledCountdownComponent } from './scheduled-countdown.component';

@Component({ selector: 'app-automation-countdown', standalone: true, imports: [ScheduledCountdownComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-scheduled-countdown [deadline]="deadline()" [waitingForIdle]="waitingForIdle()" />`,
})
export class AutomationCountdownComponent {
  readonly automation = input.required<Automation>();
  private readonly automations = inject(AutomationStore);
  private readonly instances = inject(InstanceStore);
  private readonly pending = computed(() => this.automations.runs().find(run => run.automationId === this.automation().id && run.status === 'pending'));
  /**
   * A wake-up that came due mid-turn is not `pending`: the run is recorded as `skipped` with the deferral reason while the
   * held prompt waits for the turn to end, and a one-time wake-up then has no next fire time. It stays held until the
   * prompt is confirmed delivered.
   */
  private readonly held = computed(() => this.automation().destination.kind === 'thread'
    ? this.automations.runs().find(run => run.automationId === this.automation().id && run.status === 'skipped'
      && run.error === THREAD_WAKEUP_DEFERRED_BUSY && run.threadPromptDelivered !== true)
    : undefined);
  readonly deadline = computed(() => this.pending()?.scheduledAt ?? this.held()?.scheduledAt ?? this.automation().nextFireAt);
  readonly waitingForIdle = computed(() => {
    const destination = this.automation().destination;
    if (this.held()) return true;
    if (!this.pending() || destination.kind !== 'thread') return false;
    const session = this.instances.getInstance(destination.instanceId);
    return Boolean(session && ['busy', 'processing', 'thinking_deeply', 'waiting_for_input', 'waiting_for_permission'].includes(session.status));
  });
}
