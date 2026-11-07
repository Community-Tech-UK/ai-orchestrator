import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { AutomationStore } from '../../core/state/automation.store';
import { AutomationCountdownComponent } from '../../shared/components/automation-countdown.component';

@Component({ selector: 'app-session-wakeups', standalone: true, imports: [AutomationCountdownComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (wakeup of wakeups(); track wakeup.id) {
    <p>Wake-up: <app-automation-countdown [automation]="wakeup" /></p>
  }`, styles: [`p { margin: 4px 0; color: var(--text-secondary); font-size: 11px; }`],
})
export class SessionWakeupsComponent {
  readonly instanceId = input.required<string>();
  private readonly automations = inject(AutomationStore);
  readonly wakeups = computed(() => this.automations.threadWakeupsForInstance(this.instanceId()));
}
