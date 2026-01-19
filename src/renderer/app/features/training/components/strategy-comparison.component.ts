/**
 * Strategy Comparison Component
 *
 * Compare performance across different strategies:
 * - Grouped bar chart for side-by-side comparison
 * - Box plot for distribution visualization
 * - Radar chart for multi-metric comparison
 * - Strategy selection and table view
 */

import {
  Component,
  input,
  signal,
  computed,
  effect,
  ChangeDetectionStrategy,
  ElementRef,
  viewChild,
  OnDestroy,
  afterNextRender,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import * as echarts from 'echarts';
import type { ECharts, EChartsOption } from 'echarts';

export interface StrategyPerformance {
  strategyId: string;
  name: string;
  avgReward: number;
  count: number;
  rewards: number[];
  successRate: number;
  avgDuration: number;
  trend: number; // Positive = improving, negative = declining
}

type ChartView = 'bar' | 'radar';

@Component({
  selector: 'app-strategy-comparison',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="comparison-container">
      <div class="comparison-header">
        <h3 class="comparison-title">Strategy Comparison</h3>
        <div class="controls">
          <div class="view-toggle">
            <button
              class="toggle-btn"
              [class.active]="chartView() === 'bar'"
              (click)="setChartView('bar')"
            >
              Bar
            </button>
            <button
              class="toggle-btn"
              [class.active]="chartView() === 'radar'"
              (click)="setChartView('radar')"
            >
              Radar
            </button>
          </div>
        </div>
      </div>

      <div class="comparison-content">
        <!-- Chart Area -->
        <div class="chart-section">
          <div #chartContainer class="chart-area"></div>
        </div>

        <!-- Strategy Table -->
        <div class="table-section">
          <table class="strategy-table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Avg Reward</th>
                <th>Samples</th>
                <th>Success</th>
                <th>Trend</th>
              </tr>
            </thead>
            <tbody>
              @for (strategy of sortedStrategies(); track strategy.strategyId) {
                <tr
                  [class.selected]="isSelected(strategy.strategyId)"
                  (click)="toggleStrategy(strategy.strategyId)"
                >
                  <td class="strategy-name">
                    <span class="strategy-indicator" [class.selected]="isSelected(strategy.strategyId)"></span>
                    {{ strategy.name }}
                  </td>
                  <td class="reward-value">
                    {{ strategy.avgReward.toFixed(3) }}
                  </td>
                  <td class="count-value">{{ strategy.count }}</td>
                  <td class="success-value">{{ (strategy.successRate * 100).toFixed(0) }}%</td>
                  <td class="trend-value">
                    @if (strategy.trend > 0.01) {
                      <span class="trend up">↑</span>
                    } @else if (strategy.trend < -0.01) {
                      <span class="trend down">↓</span>
                    } @else {
                      <span class="trend neutral">→</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>

      @if (strategies().length === 0) {
        <div class="empty-state">
          <span class="empty-icon">📊</span>
          <span class="empty-text">No strategy data yet</span>
        </div>
      }
    </div>
  `,
  styles: [`
    .comparison-container {
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      height: 100%;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    .comparison-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-sm);
    }

    .comparison-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }

    .controls {
      display: flex;
      gap: var(--spacing-sm);
    }

    .view-toggle {
      display: flex;
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }

    .toggle-btn {
      padding: 4px 10px;
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 10px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        color: var(--text-primary);
        background: var(--bg-hover);
      }

      &.active {
        background: var(--primary-color);
        color: white;
      }
    }

    .comparison-content {
      flex: 1;
      display: flex;
      gap: var(--spacing-sm);
      overflow: hidden;
    }

    .chart-section {
      flex: 1;
      min-width: 0;
    }

    .chart-area {
      height: 100%;
      min-height: 200px;
    }

    .table-section {
      width: 250px;
      overflow-y: auto;
    }

    .strategy-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 10px;

      th, td {
        padding: 6px 8px;
        text-align: left;
        border-bottom: 1px solid var(--border-color);
      }

      th {
        color: var(--text-muted);
        font-weight: 600;
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: var(--bg-secondary);
        position: sticky;
        top: 0;
      }

      tbody tr {
        cursor: pointer;
        transition: background var(--transition-fast);

        &:hover {
          background: var(--bg-hover);
        }

        &.selected {
          background: rgba(99, 102, 241, 0.1);
        }
      }
    }

    .strategy-name {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--text-primary);
    }

    .strategy-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--bg-tertiary);
      border: 2px solid var(--border-color);

      &.selected {
        background: var(--primary-color);
        border-color: var(--primary-color);
      }
    }

    .reward-value {
      color: var(--text-primary);
      font-family: var(--font-mono);
    }

    .count-value {
      color: var(--text-secondary);
    }

    .success-value {
      color: #10b981;
    }

    .trend-value {
      text-align: center;
    }

    .trend {
      font-weight: 600;

      &.up {
        color: #10b981;
      }

      &.down {
        color: #ef4444;
      }

      &.neutral {
        color: var(--text-muted);
      }
    }

    .empty-state {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-sm);
      color: var(--text-muted);
      pointer-events: none;
    }

    .empty-icon {
      font-size: 32px;
      opacity: 0.5;
    }

    .empty-text {
      font-size: 12px;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StrategyComparisonComponent implements OnDestroy {
  /** Input strategy performance data */
  strategies = input<StrategyPerformance[]>([]);

  /** Chart container reference */
  chartContainer = viewChild<ElementRef<HTMLDivElement>>('chartContainer');

  /** Current chart view */
  chartView = signal<ChartView>('bar');

  /** Selected strategies for comparison */
  selectedStrategies = signal<Set<string>>(new Set());

  /** Sorted strategies by avgReward */
  sortedStrategies = computed(() => {
    return [...this.strategies()].sort((a, b) => b.avgReward - a.avgReward);
  });

  /** ECharts instance */
  private chart: ECharts | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    afterNextRender(() => {
      this.initChart();
    });

    // Auto-select top 5 strategies
    effect(() => {
      const strategies = this.strategies();
      if (strategies.length > 0 && this.selectedStrategies().size === 0) {
        const top5 = strategies
          .sort((a, b) => b.avgReward - a.avgReward)
          .slice(0, 5)
          .map(s => s.strategyId);
        this.selectedStrategies.set(new Set(top5));
      }
    }, { allowSignalWrites: true });

    effect(() => {
      const view = this.chartView();
      const selected = this.selectedStrategies();
      const strategies = this.strategies();
      this.updateChart(strategies, selected, view);
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.chart?.dispose();
  }

  setChartView(view: ChartView): void {
    this.chartView.set(view);
  }

  isSelected(strategyId: string): boolean {
    return this.selectedStrategies().has(strategyId);
  }

  toggleStrategy(strategyId: string): void {
    const current = new Set(this.selectedStrategies());
    if (current.has(strategyId)) {
      current.delete(strategyId);
    } else {
      current.add(strategyId);
    }
    this.selectedStrategies.set(current);
  }

  private initChart(): void {
    const container = this.chartContainer()?.nativeElement;
    if (!container) return;

    this.chart = echarts.init(container, 'dark', {
      renderer: 'canvas',
    });

    this.resizeObserver = new ResizeObserver(() => {
      this.chart?.resize();
    });
    this.resizeObserver.observe(container);

    this.updateChart(this.strategies(), this.selectedStrategies(), this.chartView());
  }

  private updateChart(
    strategies: StrategyPerformance[],
    selected: Set<string>,
    view: ChartView
  ): void {
    if (!this.chart) return;

    const filteredStrategies = strategies.filter(s => selected.has(s.strategyId));

    if (view === 'bar') {
      this.renderBarChart(filteredStrategies);
    } else {
      this.renderRadarChart(filteredStrategies);
    }
  }

  private renderBarChart(strategies: StrategyPerformance[]): void {
    if (!this.chart) return;

    const colors = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

    const option: EChartsOption = {
      backgroundColor: 'transparent',
      grid: {
        left: 50,
        right: 20,
        top: 30,
        bottom: 60,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(30, 30, 30, 0.95)',
        borderColor: 'var(--border-color)',
        textStyle: {
          color: '#fff',
          fontSize: 11,
        },
      },
      legend: {
        bottom: 0,
        textStyle: {
          color: '#888',
          fontSize: 9,
        },
        itemWidth: 12,
        itemHeight: 8,
      },
      xAxis: {
        type: 'category',
        data: ['Avg Reward', 'Success Rate', 'Normalized Count'],
        axisLabel: {
          color: '#888',
          fontSize: 9,
        },
        axisLine: {
          lineStyle: { color: '#333' },
        },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 1,
        axisLabel: {
          color: '#888',
          fontSize: 9,
          formatter: (value: number) => value.toFixed(1),
        },
        axisLine: {
          lineStyle: { color: '#333' },
        },
        splitLine: {
          lineStyle: { color: '#222' },
        },
      },
      series: strategies.map((strategy, index) => {
        const maxCount = Math.max(...strategies.map(s => s.count), 1);
        return {
          name: strategy.name,
          type: 'bar',
          data: [
            strategy.avgReward,
            strategy.successRate,
            strategy.count / maxCount,
          ],
          itemStyle: {
            color: colors[index % colors.length],
            borderRadius: [2, 2, 0, 0],
          },
        };
      }),
    };

    this.chart.setOption(option, { notMerge: true });
  }

  private renderRadarChart(strategies: StrategyPerformance[]): void {
    if (!this.chart) return;

    const colors = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
    const maxCount = Math.max(...strategies.map(s => s.count), 1);
    const maxDuration = Math.max(...strategies.map(s => s.avgDuration), 1);

    const option: EChartsOption = {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(30, 30, 30, 0.95)',
        borderColor: 'var(--border-color)',
        textStyle: {
          color: '#fff',
          fontSize: 11,
        },
      },
      legend: {
        bottom: 0,
        textStyle: {
          color: '#888',
          fontSize: 9,
        },
        itemWidth: 12,
        itemHeight: 8,
      },
      radar: {
        indicator: [
          { name: 'Reward', max: 1 },
          { name: 'Success', max: 1 },
          { name: 'Samples', max: 1 },
          { name: 'Speed', max: 1 },
          { name: 'Trend', max: 1 },
        ],
        center: ['50%', '45%'],
        radius: '60%',
        axisName: {
          color: '#888',
          fontSize: 9,
        },
        splitLine: {
          lineStyle: { color: '#333' },
        },
        splitArea: {
          areaStyle: {
            color: ['rgba(50, 50, 50, 0.3)', 'rgba(40, 40, 40, 0.3)'],
          },
        },
        axisLine: {
          lineStyle: { color: '#333' },
        },
      },
      series: [{
        type: 'radar',
        data: strategies.map((strategy, index) => ({
          name: strategy.name,
          value: [
            strategy.avgReward,
            strategy.successRate,
            strategy.count / maxCount,
            1 - (strategy.avgDuration / maxDuration), // Invert so higher is better
            (strategy.trend + 1) / 2, // Normalize trend from [-1, 1] to [0, 1]
          ],
          itemStyle: {
            color: colors[index % colors.length],
          },
          areaStyle: {
            color: colors[index % colors.length],
            opacity: 0.2,
          },
          lineStyle: {
            color: colors[index % colors.length],
            width: 2,
          },
        })),
      }],
    };

    this.chart.setOption(option, { notMerge: true });
  }
}
