import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-session-hover-card', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="session-hover-card"><strong>{{ name() }}</strong><span>{{ status() }}</span>
    @if (pendingText()) { <p>{{ pendingText() }}</p> }
    @if (step()) { <p>{{ step() }}</p> }
  </div>`,
  styles: [`.session-hover-card { display:flex; flex-direction:column; gap:4px; max-width:320px; overflow-wrap:anywhere; } span { color:var(--text-secondary); } p { margin:0; }`],
})
export class SessionHoverCardComponent {
  readonly name = input.required<string>();
  readonly status = input.required<string>();
  readonly pendingText = input<string | null>(null);
  readonly step = input<string | null>(null);
}
