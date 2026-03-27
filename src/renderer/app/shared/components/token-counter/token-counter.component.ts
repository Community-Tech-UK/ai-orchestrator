/**
 * Token Counter Component
 *
 * Displays token usage with visual indicators:
 * - Input/output token breakdown
 * - Progress bar visualization
 * - Animated counter
 * - Cost estimation
 */

import {
  Component,
  input,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-token-counter',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="token-counter" [class.compact]="compact()">
      <!-- Main counter -->
      <div class="counter-main">
        <span class="token-icon">{{ icon() }}</span>
        <span class="token-value">{{ formattedTotal() }}</span>
        <span class="token-label">tokens</span>
      </div>

      <!-- Breakdown (if showing) -->
      @if (showBreakdown() && (inputTokens() > 0 || outputTokens() > 0)) {
        <div class="breakdown">
          <div class="breakdown-item input">
            <span class="breakdown-label">In:</span>
            <span class="breakdown-value">{{ formatNumber(inputTokens()) }}</span>
          </div>
          <span class="breakdown-divider">/</span>
          <div class="breakdown-item output">
            <span class="breakdown-label">Out:</span>
            <span class="breakdown-value">{{ formatNumber(outputTokens()) }}</span>
          </div>
        </div>
      }

      <!-- Progress bar (if max provided) -->
      @if (maxTokens() > 0) {
        <div class="progress-container">
          <div
            class="progress-bar"
            [style.width.%]="usagePercent()"
            [class.warning]="usagePercent() > 75"
            [class.danger]="usagePercent() > 90"
          ></div>
        </div>
        <div class="progress-label">
          {{ usagePercent().toFixed(0) }}% of {{ formatNumber(maxTokens()) }}
        </div>
      }

      <!-- Cost (if provided) -->
      @if (showCost() && cost() !== undefined) {
        <div class="cost-display">
          <span class="cost-value">{{ formatCost(cost()) }}</span>
        </div>
      }
    </div>
  `,
  styles: [`
    .token-counter {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      background: var(--bg-secondary, #1a1a1a);
      border-radius: 8px;
      border: 1px solid var(--border-color, #374151);
    }

    .token-counter.compact {
      flex-direction: row;
      align-items: center;
      padding: 8px 12px;
      gap: 12px;
    }

    .counter-main {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }

    .token-icon {
      font-size: 16px;
    }

    .token-value {
      font-size: 24px;
      font-weight: 600;
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
    }

    .compact .token-value {
      font-size: 16px;
    }

    .token-label {
      font-size: 13px;
      color: var(--text-muted, #6b7280);
    }

    .breakdown {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .breakdown-item {
      display: flex;
      gap: 4px;
    }

    .breakdown-label {
      color: var(--text-muted, #6b7280);
    }

    .breakdown-value {
      font-variant-numeric: tabular-nums;
    }

    .breakdown-item.input .breakdown-value {
      color: #3b82f6;
    }

    .breakdown-item.output .breakdown-value {
      color: #22c55e;
    }

    .breakdown-divider {
      color: var(--text-muted, #6b7280);
    }

    .progress-container {
      height: 4px;
      background: var(--bg-tertiary, #262626);
      border-radius: 2px;
      overflow: hidden;
    }

    .progress-bar {
      height: 100%;
      background: var(--accent-color, #3b82f6);
      border-radius: 2px;
      transition: width 0.3s ease;
    }

    .progress-bar.warning {
      background: #f59e0b;
    }

    .progress-bar.danger {
      background: #ef4444;
    }

    .progress-label {
      font-size: 11px;
      color: var(--text-muted, #6b7280);
      text-align: right;
    }

    .cost-display {
      display: flex;
      align-items: center;
      gap: 4px;
      padding-top: 4px;
      border-top: 1px solid var(--border-color, #374151);
    }

    .compact .cost-display {
      padding-top: 0;
      padding-left: 8px;
      border-top: none;
      border-left: 1px solid var(--border-color, #374151);
    }

    .cost-value {
      font-size: 13px;
      font-weight: 500;
      color: #22c55e;
    }
  `],
})
export class TokenCounterComponent {
  // Inputs
  totalTokens = input<number>(0);
  inputTokens = input<number>(0);
  outputTokens = input<number>(0);
  maxTokens = input<number>(0);
  cost = input<number | undefined>(undefined);
  showBreakdown = input<boolean>(true);
  showCost = input<boolean>(true);
  compact = input<boolean>(false);
  icon = input<string>('🔤');

  // Computed
  formattedTotal = computed(() => this.formatNumber(this.totalTokens()));

  usagePercent = computed(() => {
    const max = this.maxTokens();
    if (max <= 0) return 0;
    return Math.min(100, (this.totalTokens() / max) * 100);
  });

  // ============================================
  // Formatting
  // ============================================

  formatNumber(value: number): string {
    if (value < 1000) return value.toString();
    if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
    // Show compact "1.5m" format for ≥1M tokens (inspired by CC 2.1.84)
    return `${(value / 1_000_000).toFixed(1)}m`;
  }

  formatCost(cost: number | undefined): string {
    if (cost === undefined) return '';
    if (cost === 0) return 'Free';
    if (cost < 0.01) return '<$0.01';
    return `$${cost.toFixed(2)}`;
  }
}
