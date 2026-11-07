import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { Automation } from '../../../../shared/types/automation.types';
import { AutomationStore } from '../../core/state/automation.store';
import { InstanceStore } from '../../core/state/instance.store';
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
  readonly deadline = computed(() => this.pending()?.scheduledAt ?? this.automation().nextFireAt);
  readonly waitingForIdle = computed(() => {
    const destination = this.automation().destination;
    if (!this.pending() || destination.kind !== 'thread') return false;
    const session = this.instances.getInstance(destination.instanceId);
    return Boolean(session && ['busy', 'processing', 'thinking_deeply', 'waiting_for_input', 'waiting_for_permission'].includes(session.status));
  });
}
