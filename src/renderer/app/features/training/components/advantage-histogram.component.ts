/**
 * Advantage Distribution Histogram Component
 *
 * Visualizes the distribution of advantage scores:
 * - Histogram bins showing advantage ranges
 * - Color coding (red for negative, green for positive)
 * - Interactive hover tooltips
 */

import {
  Component,
  input,
  effect,
  ChangeDetectionStrategy,
  ElementRef,
  viewChild,
  OnDestroy,
  afterNextRender,
} from '@angular/core';
import * as echarts from 'echarts';
import type { ECharts, EChartsOption } from 'echarts';

export interface AdvantageDataPoint {
  advantage: number;
  batchIndex: number;
}

interface HistogramBin {
  label: string;
  count: number;
  min: number;
  max: number;
}

@Component({
  selector: 'app-advantage-histogram',
  standalone: true,
  template: `
    <div class="chart-container">
      <div class="chart-header">
        <h3 class="chart-title">Advantage Distribution</h3>
        <div class="stats">
          @if (data().length > 0) {
            <span class="stat-item">
              Mean: {{ getMean().toFixed(2) }}
            </span>
            <span class="stat-item">
              Std: {{ getStd().toFixed(2) }}
            </span>
          }
        </div>
      </div>
      <div #chartContainer class="chart-area"></div>
      @if (data().length === 0) {
        <div class="empty-state">
          <span class="empty-icon">📊</span>
          <span class="empty-text">No advantage data yet</span>
        </div>
      }
    </div>
  `,
  styles: [`
    .chart-container {
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      height: 100%;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    .chart-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-sm);
    }

    .chart-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }

    .stats {
      display: flex;
      gap: var(--spacing-md);
    }

    .stat-item {
      font-size: 10px;
      color: var(--text-muted);
    }

    .chart-area {
      flex: 1;
      min-height: 180px;
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
export class AdvantageHistogramComponent implements OnDestroy {
  /** Input advantage data points */
  data = input<AdvantageDataPoint[]>([]);

  /** Chart container reference */
  chartContainer = viewChild<ElementRef<HTMLDivElement>>('chartContainer');

  /** ECharts instance */
  private chart: ECharts | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    afterNextRender(() => {
      this.initChart();
    });

    effect(() => {
      const data = this.data();
      this.updateChart(data);
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.chart?.dispose();
  }

  getMean(): number {
    const advantages = this.data().map(d => d.advantage);
    if (advantages.length === 0) return 0;
    return advantages.reduce((a, b) => a + b, 0) / advantages.length;
  }

  getStd(): number {
    const advantages = this.data().map(d => d.advantage);
    if (advantages.length === 0) return 0;
    const mean = this.getMean();
    const variance = advantages.reduce((sum, v) => sum + (v - mean) ** 2, 0) / advantages.length;
    return Math.sqrt(variance);
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

    this.updateChart(this.data());
  }

  private updateChart(data: AdvantageDataPoint[]): void {
    if (!this.chart) return;

    const bins = this.computeHistogramBins(data.map(d => d.advantage));

    const option: EChartsOption = {
      backgroundColor: 'transparent',
      grid: {
        left: 50,
        right: 20,
        top: 20,
        bottom: 40,
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'shadow',
        },
        backgroundColor: 'rgba(30, 30, 30, 0.95)',
        borderColor: 'var(--border-color)',
        textStyle: {
          color: '#fff',
          fontSize: 11,
        },
        formatter: (params: any) => {
          const item = params[0];
          const bin = bins[item.dataIndex];
          return `
            <div style="font-size: 11px;">
              <div style="color: #888;">Range: ${bin.label}</div>
              <div style="margin-top: 4px;">
                Count: <strong>${bin.count}</strong>
              </div>
            </div>
          `;
        },
      },
      xAxis: {
        type: 'category',
        name: 'Advantage Range',
        nameLocation: 'middle',
        nameGap: 25,
        nameTextStyle: {
          color: '#888',
          fontSize: 10,
        },
        data: bins.map(b => b.label),
        axisLabel: {
          color: '#888',
          fontSize: 8,
          rotate: 45,
        },
        axisLine: {
          lineStyle: { color: '#333' },
        },
      },
      yAxis: {
        type: 'value',
        name: 'Count',
        nameTextStyle: {
          color: '#888',
          fontSize: 10,
        },
        axisLabel: {
          color: '#888',
          fontSize: 9,
        },
        axisLine: {
          lineStyle: { color: '#333' },
        },
        splitLine: {
          lineStyle: { color: '#222' },
        },
      },
      series: [{
        type: 'bar',
        data: bins.map(bin => ({
          value: bin.count,
          itemStyle: {
            color: this.getBinColor(bin.min, bin.max),
            borderRadius: [2, 2, 0, 0],
          },
        })),
        barWidth: '80%',
      }],
    };

    this.chart.setOption(option, { notMerge: true });
  }

  private computeHistogramBins(values: number[]): HistogramBin[] {
    if (values.length === 0) {
      // Return empty bins
      const defaultBins: HistogramBin[] = [];
      for (let i = -2; i < 2; i += 0.5) {
        defaultBins.push({
          label: `[${i.toFixed(1)}, ${(i + 0.5).toFixed(1)})`,
          count: 0,
          min: i,
          max: i + 0.5,
        });
      }
      return defaultBins;
    }

    // Define bins from -3 to 3 with 0.5 width
    const binWidth = 0.5;
    const minBin = -3;
    const maxBin = 3;
    const bins: HistogramBin[] = [];

    for (let i = minBin; i < maxBin; i += binWidth) {
      bins.push({
        label: `[${i.toFixed(1)}, ${(i + binWidth).toFixed(1)})`,
        count: 0,
        min: i,
        max: i + binWidth,
      });
    }

    // Count values in each bin
    for (const value of values) {
      const binIndex = Math.floor((value - minBin) / binWidth);
      if (binIndex >= 0 && binIndex < bins.length) {
        bins[binIndex].count++;
      } else if (value >= maxBin) {
        bins[bins.length - 1].count++;
      } else if (value < minBin) {
        bins[0].count++;
      }
    }

    return bins;
  }

  private getBinColor(min: number, max: number): string {
    const midpoint = (min + max) / 2;

    if (midpoint < -1) {
      return '#ef4444'; // Strong negative - red
    } else if (midpoint < 0) {
      return '#f97316'; // Weak negative - orange
    } else if (midpoint < 1) {
      return '#22c55e'; // Weak positive - green
    } else {
      return '#10b981'; // Strong positive - emerald
    }
  }
}
