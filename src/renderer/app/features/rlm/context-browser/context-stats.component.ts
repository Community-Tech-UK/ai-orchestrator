/**
 * Context Stats Component - Displays stats overview cards
 */

import { Component, input, ChangeDetectionStrategy } from '@angular/core';
import type { ContextStore } from '../../../../../shared/types/rlm.types';

@Component({
  selector: 'app-context-stats',
  standalone: true,
  template: `
    <div class="stats-overview">
      <div class="stat-card">
        <span class="stat-label">Total Tokens</span>
        <span class="stat-value">{{ formatNumber(store().totalTokens) }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Sections</span>
        <span class="stat-value">{{ store().sections.length }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Size</span>
        <span class="stat-value">{{ formatBytes(store().totalSize) }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Access Count</span>
        <span class="stat-value">{{ store().accessCount }}</span>
      </div>
    </div>
  `,
  styles: [
    `
      .stats-overview {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
      }

      .stat-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: var(--spacing-sm);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
      }

      .stat-label {
        font-size: 10px;
        color: var(--text-muted);
        font-weight: 600;
      }

      .stat-value {
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ContextStatsComponent {
  store = input.required<ContextStore>();

  formatNumber(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }

  formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
  }
}
