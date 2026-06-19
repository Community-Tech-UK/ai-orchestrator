import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { InspectorProgressView } from './loop-formatters.util';

/**
 * The inspector's at-a-glance progress header. Purely presentational — it
 * renders a pre-computed {@link InspectorProgressView} (built by
 * `buildInspectorProgress`) so the parent owns the live tick and store wiring.
 *
 * Answers "is this loop nearly finished, or hasn't it started?" with a status
 * pill, a headline, the current stage, and a progress bar per cap
 * (iterations / time / tokens / cost). The fullest bar is the binding
 * constraint; uncapped budgets (`pct === null`) show the running total with no
 * bar.
 */
@Component({
  selector: 'app-loop-inspector-progress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (view(); as p) {
      <div class="li-progress" [attr.data-status]="p.status">
        <div class="li-progress-head">
          <span class="li-progress-status" [attr.data-status]="p.status">{{ p.statusLabel }}</span>
          <span class="li-progress-headline">{{ p.headline }}</span>
          <span class="li-progress-stage">{{ p.stageText }}</span>
        </div>
        <div class="li-progress-bars">
          @for (m of p.metrics; track m.key) {
            <div class="li-metric" [class.uncapped]="m.pct === null" [title]="m.tooltip">
              <div class="li-metric-top">
                <span class="li-metric-label">{{ m.label }}</span>
                <span class="li-metric-value">{{ m.valueText }}</span>
              </div>
              <div class="li-metric-track">
                @if (m.pct !== null) {
                  <div class="li-metric-fill" [class.near]="m.pct >= 75" [class.full]="m.pct >= 100" [style.width.%]="m.pct"></div>
                }
              </div>
            </div>
          }
        </div>
        @if (p.completionText) {
          <div class="li-progress-completion">{{ p.completionText }}</div>
        }
        <div class="li-progress-note">Loop stops when the completion gate clears or any capped bar fills.</div>
      </div>
    }
  `,
  styleUrl: './loop-inspector-progress.component.scss',
})
export class LoopInspectorProgressComponent {
  view = input<InspectorProgressView | null>(null);
}
