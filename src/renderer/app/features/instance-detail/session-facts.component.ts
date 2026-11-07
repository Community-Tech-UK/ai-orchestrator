import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
import { sessionFacts } from '../../../../shared/utils/session-facts';

@Component({
  selector: 'app-session-facts', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<details class="session-facts" (toggle)="open.set($any($event.target).open === true)">
    <summary>Session facts</summary>
    @if (open()) {
    <section aria-label="Session facts">
      <p>From the conversation currently loaded. A call without a recorded result may still be running.</p>
      <p>{{ facts().failed }} failed tools · {{ facts().compactions }} compactions</p>
      <h4>Slowest tools</h4>
      @for (tool of facts().slowest; track tool.id) { <p>{{ tool.name }}: {{ seconds(tool.durationMs) }} s</p> }
      @empty { <p>Unverified: no paired tool timings recorded.</p> }
      <h4>No result recorded</h4>
      @for (tool of facts().withoutRecordedResult; track tool.id) { <p>{{ tool.name }}</p> }
      @empty { <p>None in the loaded conversation.</p> }
      @if (facts().unmatchedIdentity) { <p>{{ facts().unmatchedIdentity }} tool messages could not be paired.</p> }
    </section>
    }
  </details>`,
  styles: [`:host { display: block; } summary { cursor: pointer; font-size: 11px; }
    section { max-height: 60vh; overflow: auto; padding: 8px 0; font-size: 12px; }`],
})
export class SessionFactsComponent {
  readonly instanceId = input.required<string>();
  private readonly instances = inject(InstanceStore);
  /** The transcript is only walked while the section is open, so streaming never pays for a closed one. */
  protected readonly open = signal(false);
  readonly facts = computed(() => sessionFacts(this.instances.getInstance(this.instanceId())?.outputBuffer ?? []));
  seconds(milliseconds: number): string { return (milliseconds / 1000).toFixed(1); }
}
