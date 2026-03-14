/**
 * Context Bar Component - Visual indicator of token/context usage
 */

import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ContextUsage } from '../../core/state/instance.store';

@Component({
  selector: 'app-context-bar',
  standalone: true,
  imports: [DecimalPipe],
  template: `
    <div class="context-bar" [class.compact]="compact()">
      <div class="bar-track">
        <div
          class="bar-fill"
          [style.width.%]="percentage()"
          [class.warning]="percentage() > 70"
          [class.danger]="percentage() > 90"
        ></div>
      </div>

      @if (showDetails()) {
        <div class="bar-details">
          <span class="used">{{ usage().used | number:'1.0-0' }}</span>
          <span class="separator">/</span>
          <span class="total">{{ usage().total | number:'1.0-0' }}</span>
          <span class="percentage">({{ percentage() | number:'1.0-0' }}%)</span>
          @if (showCost() && costEstimate()) {
            <span class="cost">≈{{ costEstimate() | number:'1.2-2' }} USD</span>
          }
        </div>
      } @else {
        <span class="compact-label">{{ percentage() | number:'1.0-0' }}%</span>
      }
    </div>
  `,
  styles: [`
    .context-bar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .context-bar.compact {
      grid-template-columns: minmax(0, 1fr) auto;
      width: 72px;
    }

    .bar-track {
      min-width: 0;
      height: 10px;
      background: rgba(255, 255, 255, 0.04);
      border-radius: var(--radius-full);
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.05);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
    }

    .compact .bar-track {
      height: 6px;
    }

    .bar-fill {
      height: 100%;
      background: linear-gradient(90deg, rgba(var(--primary-rgb), 0.66), var(--primary-color));
      border-radius: var(--radius-full);
      transition: width var(--transition-normal), background var(--transition-normal);
    }

    .bar-fill.warning {
      background: linear-gradient(
        90deg,
        rgba(var(--warning-rgb, 255, 183, 77), 0.72),
        var(--warning-color)
      );
    }

    .bar-fill.danger {
      background: linear-gradient(90deg, rgba(var(--error-rgb), 0.72), var(--error-color));
    }

    .bar-details {
      font-size: 10px;
      color: var(--text-secondary);
      font-family: var(--font-mono);
      white-space: nowrap;
      letter-spacing: 0.04em;
      text-align: right;
    }

    .used {
      color: var(--text-primary);
    }

    .separator {
      color: var(--text-muted);
      margin: 0 2px;
    }

    .total {
      color: var(--text-muted);
    }

    .percentage {
      color: var(--text-secondary);
      margin-left: 4px;
    }

    .cost {
      color: var(--warning-color);
      margin-left: 8px;
      font-weight: 500;
    }

    .compact-label {
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      min-width: 28px;
      text-align: right;
    }

    @media (max-width: 720px) {
      .context-bar {
        grid-template-columns: 1fr;
        gap: 6px;
      }

      .bar-details,
      .compact-label {
        text-align: left;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContextBarComponent {
  usage = input.required<ContextUsage>();
  compact = input<boolean>(false);
  showDetails = input<boolean>(false);
  showCost = input<boolean>(true);

  percentage = computed(() => {
    const usage = this.usage();
    // Cap at 100% for display - used can exceed total in long sessions
    // due to context window truncation or summarization.
    const raw = usage.total > 0 ? (usage.used / usage.total) * 100 : 0;
    return Math.min(raw, 100);
  });

  costEstimate = computed(() => {
    const cost = this.usage().costEstimate;
    return cost !== undefined && cost > 0 ? cost : null;
  });
}
