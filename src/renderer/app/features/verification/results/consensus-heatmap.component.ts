/**
 * Consensus Heatmap Component
 *
 * Visual representation of agreement levels between agents:
 * - Color-coded matrix showing pairwise agreement
 * - Percentage display for each cell
 * - Legend for color interpretation
 */

import {
  Component,
  input,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';

interface Agent {
  id: string;
  name: string;
}

@Component({
  selector: 'app-consensus-heatmap',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="heatmap-container">
      <!-- Matrix Table -->
      <div class="matrix-wrapper">
        <table class="matrix-table">
          <thead>
            <tr>
              <th class="corner-cell"></th>
              @for (agent of agents(); track agent.id) {
                <th class="header-cell">{{ agent.name }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (rowAgent of agents(); track rowAgent.id; let rowIdx = $index) {
              <tr>
                <td class="row-header">{{ rowAgent.name }}</td>
                @for (colAgent of agents(); track colAgent.id; let colIdx = $index) {
                  <td
                    class="matrix-cell"
                    [class]="getCellClass(rowIdx, colIdx)"
                    [class.diagonal]="rowIdx === colIdx"
                    tabindex="0"
                    [appTooltip]="getCellTitle(rowAgent.name, colAgent.name, rowIdx, colIdx)"
                  >
                    @if (rowIdx === colIdx) {
                      <span class="diagonal-text">—</span>
                    } @else {
                      <span class="cell-value">{{ getCellValue(rowIdx, colIdx) }}%</span>
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>

      <!-- Legend -->
      <div class="legend">
        <span class="legend-label">Legend:</span>
        <div class="legend-item">
          <div class="legend-color high"></div>
          <span>&gt;80%</span>
        </div>
        <div class="legend-item">
          <div class="legend-color medium-high"></div>
          <span>60-80%</span>
        </div>
        <div class="legend-item">
          <div class="legend-color medium"></div>
          <span>40-60%</span>
        </div>
        <div class="legend-item">
          <div class="legend-color low"></div>
          <span>&lt;40%</span>
        </div>
      </div>

      <!-- Notes -->
      @if (hasOutlier()) {
        <div class="heatmap-note">
          Note: Lower agreement scores may indicate intentional contrarian perspectives (e.g., Devil's Advocate)
        </div>
      }
    </div>
  `,
  styles: [`
    .heatmap-container {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .matrix-wrapper {
      overflow-x: auto;
    }

    .matrix-table {
      border-collapse: separate;
      border-spacing: 4px;
      width: 100%;
      min-width: 400px;
    }

    .corner-cell {
      width: 80px;
    }

    .header-cell {
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 500;
      text-align: center;
      color: var(--text-primary);
      white-space: nowrap;
    }

    .row-header {
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 500;
      text-align: right;
      color: var(--text-primary);
      white-space: nowrap;
    }

    .matrix-cell {
      width: 70px;
      height: 48px;
      text-align: center;
      vertical-align: middle;
      border-radius: 6px;
      transition: all 0.2s;
    }

    .matrix-cell:hover:not(.diagonal) {
      transform: scale(1.05);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }

    .matrix-cell:focus-visible {
      outline: 2px solid var(--accent-color, #3b82f6);
      outline-offset: 2px;
    }

    .matrix-cell.diagonal {
      background: var(--bg-tertiary);
    }

    .matrix-cell.high {
      background: rgba(34, 197, 94, 0.8);
      color: white;
    }

    .matrix-cell.medium-high {
      background: rgba(34, 197, 94, 0.5);
      color: white;
    }

    .matrix-cell.medium {
      background: rgba(245, 158, 11, 0.5);
      color: var(--text-primary);
    }

    .matrix-cell.low {
      background: rgba(239, 68, 68, 0.5);
      color: white;
    }

    .diagonal-text {
      color: var(--text-muted);
      font-size: 18px;
    }

    .cell-value {
      font-size: 14px;
      font-weight: 600;
    }

    .legend {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .legend-label {
      font-weight: 500;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .legend-color {
      width: 16px;
      height: 16px;
      border-radius: 4px;
    }

    .legend-color.high {
      background: rgba(34, 197, 94, 0.8);
    }

    .legend-color.medium-high {
      background: rgba(34, 197, 94, 0.5);
    }

    .legend-color.medium {
      background: rgba(245, 158, 11, 0.5);
    }

    .legend-color.low {
      background: rgba(239, 68, 68, 0.5);
    }

    .heatmap-note {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
      padding: 8px 12px;
      background: var(--bg-tertiary);
      border-radius: 4px;
    }
  `],
})
export class ConsensusHeatmapComponent {
  // Inputs - use defaults to avoid NG0950 errors in tests
  agents = input<Agent[]>([]);
  matrix = input<number[][]>([]);

  // Computed
  hasOutlier = computed(() => {
    const m = this.matrix();
    if (!m || m.length === 0) return false;

    // Check if any row has consistently low values (potential outlier)
    for (let i = 0; i < m.length; i++) {
      let lowCount = 0;
      for (let j = 0; j < m[i].length; j++) {
        if (i !== j && m[i][j] < 0.5) {
          lowCount++;
        }
      }
      if (lowCount >= m.length - 2) return true;
    }
    return false;
  });

  // ============================================
  // Cell Helpers
  // ============================================

  getCellValue(rowIdx: number, colIdx: number): number {
    const m = this.matrix();
    if (!m || !m[rowIdx]) return 0;
    return Math.round((m[rowIdx][colIdx] || 0) * 100);
  }

  getCellClass(rowIdx: number, colIdx: number): string {
    if (rowIdx === colIdx) return 'diagonal';

    const value = this.getCellValue(rowIdx, colIdx);
    if (value >= 80) return 'high';
    if (value >= 60) return 'medium-high';
    if (value >= 40) return 'medium';
    return 'low';
  }

  getCellTitle(rowName: string, colName: string, rowIdx: number, colIdx: number): string {
    if (rowIdx === colIdx) return `${rowName} (self)`;
    const value = this.getCellValue(rowIdx, colIdx);
    return `${rowName} ↔ ${colName}: ${value}% agreement`;
  }
}
