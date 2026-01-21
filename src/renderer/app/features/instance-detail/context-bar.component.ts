/**
 * Context Bar Component - Visual indicator of token/context usage
 */

import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
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
          @if (costEstimate()) {
            <span class="cost">~\${{ costEstimate() | number:'1.2-2' }}</span>
          }
        </div>
      } @else {
        <span class="compact-label">{{ percentage() | number:'1.0-0' }}%</span>
      }
    </div>
  `,
  styles: [`
    .context-bar {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .context-bar.compact {
      width: 60px;
    }

    .bar-track {
      flex: 1;
      height: 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-full);
      overflow: hidden;
    }

    .compact .bar-track {
      height: 4px;
    }

    .bar-fill {
      height: 100%;
      background: var(--primary-color);
      border-radius: var(--radius-full);
      transition: width var(--transition-normal), background var(--transition-normal);
    }

    .bar-fill.warning {
      background: var(--warning-color);
    }

    .bar-fill.danger {
      background: var(--error-color);
    }

    .bar-details {
      font-size: 12px;
      color: var(--text-secondary);
      font-family: var(--font-mono);
      white-space: nowrap;
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
      margin-left: var(--spacing-xs);
    }

    .cost {
      color: var(--warning-color);
      margin-left: var(--spacing-sm);
      font-weight: 500;
    }

    .compact-label {
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      min-width: 28px;
      text-align: right;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContextBarComponent {
  usage = input.required<ContextUsage>();
  compact = input<boolean>(false);
  showDetails = input<boolean>(false);

  percentage = computed(() => {
    const u = this.usage();
    // Cap at 100% for display - used can exceed total in long sessions
    // due to context window truncation/summarization
    const raw = u.total > 0 ? (u.used / u.total) * 100 : 0;
    return Math.min(raw, 100);
  });

  costEstimate = computed(() => {
    const cost = this.usage().costEstimate;
    return cost !== undefined && cost > 0 ? cost : null;
  });
}
