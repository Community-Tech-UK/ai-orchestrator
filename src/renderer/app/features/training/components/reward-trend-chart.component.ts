/**
 * Reward Trend Chart Component
 *
 * Visualizes training progress over time using ECharts:
 * - Real-time reward trend with smoothing options (Raw, EMA, SMA)
 * - Configurable smoothing window
 * - Zoom and pan capabilities
 * - Hover tooltips with batch details
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

export interface RewardDataPoint {
  batchIndex: number;
  reward: number;
  timestamp: number;
}

type SmoothingType = 'none' | 'ema' | 'sma';

@Component({
  selector: 'app-reward-trend-chart',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="chart-container">
      <div class="chart-header">
        <h3 class="chart-title">Reward Trend Over Time</h3>
        <div class="controls">
          <div class="smoothing-toggle">
            <button
              class="toggle-btn"
              [class.active]="smoothing() === 'none'"
              (click)="setSmoothing('none')"
            >
              Raw
            </button>
            <button
              class="toggle-btn"
              [class.active]="smoothing() === 'ema'"
              (click)="setSmoothing('ema')"
            >
              EMA
            </button>
            <button
              class="toggle-btn"
              [class.active]="smoothing() === 'sma'"
              (click)="setSmoothing('sma')"
            >
              SMA
            </button>
          </div>
          @if (smoothing() !== 'none') {
            <div class="window-control">
              <label>Window:</label>
              <input
                type="range"
                min="2"
                max="20"
                [value]="smoothingWindow()"
                (input)="onWindowChange($event)"
              />
              <span class="window-value">{{ smoothingWindow() }}</span>
            </div>
          }
        </div>
      </div>
      <div #chartContainer class="chart-area"></div>
      @if (data().length === 0) {
        <div class="empty-state">
          <span class="empty-icon">📈</span>
          <span class="empty-text">No reward data yet</span>
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
    }

    .chart-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-sm);
      flex-wrap: wrap;
      gap: var(--spacing-sm);
    }

    .chart-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }

    .controls {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .smoothing-toggle {
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

    .window-control {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: 10px;
      color: var(--text-secondary);

      label {
        color: var(--text-muted);
      }

      input[type="range"] {
        width: 60px;
        height: 4px;
        -webkit-appearance: none;
        background: var(--bg-secondary);
        border-radius: 2px;

        &::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: var(--primary-color);
          cursor: pointer;
        }
      }

      .window-value {
        min-width: 16px;
        text-align: right;
      }
    }

    .chart-area {
      flex: 1;
      min-height: 200px;
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
export class RewardTrendChartComponent implements OnDestroy {
  /** Input reward data points */
  data = input<RewardDataPoint[]>([]);

  /** Chart container reference */
  chartContainer = viewChild<ElementRef<HTMLDivElement>>('chartContainer');

  /** Smoothing type */
  smoothing = signal<SmoothingType>('ema');

  /** Smoothing window size */
  smoothingWindow = signal<number>(10);

  /** ECharts instance */
  private chart: ECharts | null = null;
  private resizeObserver: ResizeObserver | null = null;

  /** Computed smoothed data */
  private smoothedData = computed(() => {
    const raw = this.data();
    const type = this.smoothing();
    const window = this.smoothingWindow();

    if (type === 'none' || raw.length === 0) {
      return raw.map(d => d.reward);
    }

    const rewards = raw.map(d => d.reward);
    return type === 'ema'
      ? this.exponentialMovingAverage(rewards, window)
      : this.simpleMovingAverage(rewards, window);
  });

  constructor() {
    // Initialize chart after render
    afterNextRender(() => {
      this.initChart();
    });

    // Update chart when data or settings change
    effect(() => {
      const data = this.data();
      const smoothed = this.smoothedData();
      const _ = this.smoothing(); // Track smoothing changes
      this.updateChart(data, smoothed);
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.chart?.dispose();
  }

  setSmoothing(type: SmoothingType): void {
    this.smoothing.set(type);
  }

  onWindowChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.smoothingWindow.set(parseInt(target.value, 10));
  }

  private initChart(): void {
    const container = this.chartContainer()?.nativeElement;
    if (!container) return;

    this.chart = echarts.init(container, 'dark', {
      renderer: 'canvas',
    });

    // Handle resize
    this.resizeObserver = new ResizeObserver(() => {
      this.chart?.resize();
    });
    this.resizeObserver.observe(container);

    // Initial update
    this.updateChart(this.data(), this.smoothedData());
  }

  private updateChart(data: RewardDataPoint[], smoothed: number[]): void {
    if (!this.chart) return;

    const option: EChartsOption = {
      backgroundColor: 'transparent',
      grid: {
        left: 50,
        right: 20,
        top: 20,
        bottom: 50,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(30, 30, 30, 0.95)',
        borderColor: 'var(--border-color)',
        textStyle: {
          color: '#fff',
          fontSize: 11,
        },
        formatter: (params: any) => {
          const dataPoint = params[0];
          const raw = data[dataPoint.dataIndex];
          return `
            <div style="font-size: 11px;">
              <div style="color: #888;">Batch ${raw?.batchIndex ?? dataPoint.dataIndex}</div>
              <div style="margin-top: 4px;">
                <span style="display: inline-block; width: 10px; height: 10px; background: #6366f1; border-radius: 50%; margin-right: 6px;"></span>
                Reward: <strong>${dataPoint.value?.toFixed(3) ?? 'N/A'}</strong>
              </div>
              ${raw ? `<div style="color: #666; margin-top: 4px; font-size: 10px;">${new Date(raw.timestamp).toLocaleTimeString()}</div>` : ''}
            </div>
          `;
        },
      },
      xAxis: {
        type: 'value',
        name: 'Batch',
        nameLocation: 'middle',
        nameGap: 30,
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
      yAxis: {
        type: 'value',
        name: 'Reward',
        min: 0,
        max: 1,
        nameLocation: 'middle',
        nameGap: 35,
        nameTextStyle: {
          color: '#888',
          fontSize: 10,
        },
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
      dataZoom: [
        {
          type: 'slider',
          xAxisIndex: 0,
          start: 0,
          end: 100,
          height: 20,
          bottom: 5,
          borderColor: '#333',
          backgroundColor: '#1a1a1a',
          fillerColor: 'rgba(99, 102, 241, 0.2)',
          handleStyle: {
            color: '#6366f1',
          },
          textStyle: {
            color: '#888',
            fontSize: 9,
          },
        },
        {
          type: 'inside',
          xAxisIndex: 0,
        },
      ],
      series: [
        {
          name: 'Raw',
          type: 'scatter',
          symbolSize: 4,
          data: data.map((d, i) => [i, d.reward]),
          itemStyle: {
            color: 'rgba(99, 102, 241, 0.3)',
          },
          z: 1,
        },
        {
          name: 'Smoothed',
          type: 'line',
          smooth: true,
          data: smoothed.map((v, i) => [i, v]),
          lineStyle: {
            width: 2,
            color: '#6366f1',
          },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(99, 102, 241, 0.3)' },
              { offset: 1, color: 'rgba(99, 102, 241, 0.05)' },
            ]),
          },
          showSymbol: false,
          z: 2,
        },
      ],
    };

    this.chart.setOption(option, { notMerge: true });
  }

  private exponentialMovingAverage(data: number[], window: number): number[] {
    if (data.length === 0) return [];

    const alpha = 2 / (window + 1);
    const result: number[] = [data[0]];

    for (let i = 1; i < data.length; i++) {
      result.push(alpha * data[i] + (1 - alpha) * result[i - 1]);
    }

    return result;
  }

  private simpleMovingAverage(data: number[], window: number): number[] {
    if (data.length === 0) return [];

    const result: number[] = [];

    for (let i = 0; i < data.length; i++) {
      const start = Math.max(0, i - window + 1);
      const slice = data.slice(start, i + 1);
      const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
      result.push(avg);
    }

    return result;
  }
}
