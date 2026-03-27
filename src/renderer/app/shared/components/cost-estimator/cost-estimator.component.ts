/**
 * Cost Estimator Component
 *
 * Displays cost breakdown with visual bars:
 * - Per-agent cost bars
 * - Total cost summary
 * - Input/output cost split
 * - Comparison visualization
 */

import {
  Component,
  input,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type { CostBreakdown, SessionCostSummary } from '../../../../../shared/types/verification-ui.types';

@Component({
  selector: 'app-cost-estimator',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cost-estimator" [class.compact]="compact()">
      <!-- Total Cost Header -->
      <div class="total-section">
        <div class="total-label">Total Cost</div>
        <div class="total-value" [class.free]="summary().totalCost === 0">
          {{ formatCost(summary().totalCost) }}
        </div>
        <div class="total-tokens">
          {{ formatTokens(summary().totalInputTokens + summary().totalOutputTokens) }} tokens
        </div>
      </div>

      <!-- Per-Agent Breakdown -->
      @if (showBreakdown() && summary().breakdown.length > 0) {
        <div class="breakdown-section">
          <div class="breakdown-header">
            <span>Per Agent</span>
            <span class="breakdown-legend">
              <span class="legend-item input">Input</span>
              <span class="legend-item output">Output</span>
            </span>
          </div>

          @for (item of summary().breakdown; track item.agentId) {
            <div class="breakdown-row">
              <div class="agent-info">
                <span class="agent-name">{{ item.agentName }}</span>
                <span class="agent-cost">{{ formatCost(item.totalCost) }}</span>
              </div>

              <div class="cost-bar-container">
                <!-- Input bar -->
                <div
                  class="cost-bar input"
                  [style.width.%]="getBarWidth(item, 'input')"
                  [title]="'Input: ' + formatTokens(item.inputTokens) + ' tokens'"
                ></div>
                <!-- Output bar -->
                <div
                  class="cost-bar output"
                  [style.width.%]="getBarWidth(item, 'output')"
                  [style.left.%]="getBarWidth(item, 'input')"
                  [title]="'Output: ' + formatTokens(item.outputTokens) + ' tokens'"
                ></div>
              </div>

              <div class="token-breakdown">
                <span class="input-tokens">{{ formatTokens(item.inputTokens) }}</span>
                <span class="separator">/</span>
                <span class="output-tokens">{{ formatTokens(item.outputTokens) }}</span>
              </div>
            </div>
          }
        </div>
      }

      <!-- Summary Stats -->
      @if (showStats()) {
        <div class="stats-section">
          <div class="stat-item">
            <span class="stat-label">Avg per agent</span>
            <span class="stat-value">{{ formatCost(avgCostPerAgent()) }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Input cost</span>
            <span class="stat-value input">{{ formatCost(totalInputCost()) }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Output cost</span>
            <span class="stat-value output">{{ formatCost(totalOutputCost()) }}</span>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .cost-estimator {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 16px;
      background: var(--bg-secondary, #1a1a1a);
      border-radius: 8px;
      border: 1px solid var(--border-color, #374151);
    }

    .cost-estimator.compact {
      padding: 12px;
      gap: 12px;
    }

    /* Total Section */
    .total-section {
      text-align: center;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border-color, #374151);
    }

    .total-label {
      font-size: 12px;
      color: var(--text-muted, #6b7280);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .total-value {
      font-size: 28px;
      font-weight: 700;
      color: var(--text-primary);
      margin: 4px 0;
    }

    .total-value.free {
      color: #22c55e;
    }

    .compact .total-value {
      font-size: 20px;
    }

    .total-tokens {
      font-size: 13px;
      color: var(--text-secondary);
    }

    /* Breakdown Section */
    .breakdown-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .breakdown-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .breakdown-legend {
      display: flex;
      gap: 12px;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .legend-item::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 2px;
    }

    .legend-item.input::before {
      background: #3b82f6;
    }

    .legend-item.output::before {
      background: #22c55e;
    }

    /* Breakdown Row */
    .breakdown-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .agent-info {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .agent-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .agent-cost {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
    }

    .cost-bar-container {
      position: relative;
      height: 8px;
      background: var(--bg-tertiary, #262626);
      border-radius: 4px;
      overflow: hidden;
    }

    .cost-bar {
      position: absolute;
      top: 0;
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    .cost-bar.input {
      left: 0;
      background: #3b82f6;
    }

    .cost-bar.output {
      background: #22c55e;
    }

    .token-breakdown {
      display: flex;
      gap: 4px;
      font-size: 11px;
      color: var(--text-muted, #6b7280);
      font-variant-numeric: tabular-nums;
    }

    .input-tokens {
      color: #3b82f6;
    }

    .output-tokens {
      color: #22c55e;
    }

    .separator {
      color: var(--text-muted, #6b7280);
    }

    /* Stats Section */
    .stats-section {
      display: flex;
      justify-content: space-between;
      padding-top: 12px;
      border-top: 1px solid var(--border-color, #374151);
    }

    .stat-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }

    .stat-label {
      font-size: 11px;
      color: var(--text-muted, #6b7280);
    }

    .stat-value {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .stat-value.input {
      color: #3b82f6;
    }

    .stat-value.output {
      color: #22c55e;
    }
  `],
})
export class CostEstimatorComponent {
  // Inputs
  summary = input.required<SessionCostSummary>();
  showBreakdown = input<boolean>(true);
  showStats = input<boolean>(true);
  compact = input<boolean>(false);

  // Computed
  maxCost = computed(() => {
    const breakdown = this.summary().breakdown;
    if (breakdown.length === 0) return 1;
    return Math.max(...breakdown.map(b => b.totalCost));
  });

  maxTokens = computed(() => {
    const breakdown = this.summary().breakdown;
    if (breakdown.length === 0) return 1;
    return Math.max(...breakdown.map(b => b.inputTokens + b.outputTokens));
  });

  avgCostPerAgent = computed(() => {
    const breakdown = this.summary().breakdown;
    if (breakdown.length === 0) return 0;
    return this.summary().totalCost / breakdown.length;
  });

  totalInputCost = computed(() => {
    return this.summary().breakdown.reduce((sum, b) => {
      const rate = b.inputCostRate || 1;
      return sum + (b.inputTokens / 1_000_000) * rate;
    }, 0);
  });

  totalOutputCost = computed(() => {
    return this.summary().breakdown.reduce((sum, b) => {
      const rate = b.outputCostRate || 3;
      return sum + (b.outputTokens / 1_000_000) * rate;
    }, 0);
  });

  // ============================================
  // Methods
  // ============================================

  getBarWidth(item: CostBreakdown, type: 'input' | 'output'): number {
    const totalTokens = item.inputTokens + item.outputTokens;
    if (totalTokens === 0) return 0;

    const maxTotal = this.maxTokens();
    const tokens = type === 'input' ? item.inputTokens : item.outputTokens;

    return (tokens / maxTotal) * 100;
  }

  formatCost(cost: number): string {
    if (cost === 0) return 'Free';
    if (cost < 0.001) return '<$0.001';
    if (cost < 0.01) return `$${cost.toFixed(3)}`;
    return `$${cost.toFixed(2)}`;
  }

  formatTokens(tokens: number): string {
    if (tokens < 1000) return tokens.toString();
    if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
    // Show compact "1.5m" format for ≥1M tokens (inspired by CC 2.1.84)
    return `${(tokens / 1_000_000).toFixed(1)}m`;
  }
}
