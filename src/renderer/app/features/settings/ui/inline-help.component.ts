/**
 * Inline Help - contextual callout for settings sections.
 *
 * Part of the settings UI kit (copilot_todo.md item 4) and the contextual-help
 * work (item 13): a compact, variant-styled note that explains a complex
 * setting area without needing a separate help pane.
 *
 * Variants:
 *  - `info`    — neutral explanation (default)
 *  - `tip`     — a helpful hint
 *  - `warning` — something to be careful about
 */

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type InlineHelpVariant = 'info' | 'tip' | 'warning';

@Component({
  selector: 'app-inline-help',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aside class="inline-help" [attr.data-variant]="variant()">
      <span class="help-icon" aria-hidden="true">
        @switch (variant()) {
          @case ('tip') {
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18h6" />
              <path d="M10 21h4" />
              <path d="M12 3a6 6 0 0 0-4 10.5c.5.5 1 1.4 1 2.5h6c0-1.1.5-2 1-2.5A6 6 0 0 0 12 3z" />
            </svg>
          }
          @case ('warning') {
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3l10 17H2z" />
              <line x1="12" y1="9" x2="12" y2="14" />
              <line x1="12" y1="17.5" x2="12" y2="17.5" />
            </svg>
          }
          @default {
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9" />
              <line x1="12" y1="11" x2="12" y2="16" />
              <line x1="12" y1="8" x2="12" y2="8" />
            </svg>
          }
        }
      </span>
      <div class="help-body">
        @if (heading()) {
          <p class="help-heading">{{ heading() }}</p>
        }
        <div class="help-content">
          <ng-content />
        </div>
      </div>
    </aside>
  `,
  styleUrl: './inline-help.component.scss',
})
export class InlineHelpComponent {
  /** Visual treatment of the callout. */
  readonly variant = input<InlineHelpVariant>('info');
  /** Optional bold heading shown above the projected body. */
  readonly heading = input<string>();
}
