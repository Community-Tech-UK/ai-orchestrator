/**
 * Agent-Task Performance Heatmap Component
 *
 * Visualize which agents work best for which task types:
 * - Heatmap matrix with agents on Y-axis, tasks on X-axis
 * - Configurable metric (success rate, avg reward, avg duration)
 * - Color gradient from red (poor) to green (good)
 * - Interactive hover and click
 */

import {
  Component,
  input,
  signal,
  effect,
  ChangeDetectionStrategy,
  ElementRef,
  viewChild,
  OnDestroy,
  afterNextRender,
} from '@angular/core';
import * as echarts from 'echarts';
import type { ECharts, EChartsOption } from 'echarts';

export interface AgentTaskMetric {
  agentId: string;
  taskType: string;
  successRate: number;
  avgReward: number;
  avgDuration: number;
  count: number;
}

type MetricType = 'successRate' | 'avgReward' | 'avgDuration';

@Component({
  selector: 'app-agent-task-heatmap',
  standalone: true,
  template: `
    <div class="heatmap-container">
      <div class="heatmap-header">
        <h3 class="heatmap-title">Agent-Task Performance Matrix</h3>
        <div class="controls">
          <div class="metric-toggle">
            <button
              class="toggle-btn"
              [class.active]="metric() === 'successRate'"
              (click)="setMetric('successRate')"
            >
              Success Rate
            </button>
            <button
              class="toggle-btn"
              [class.active]="metric() === 'avgReward'"
              (click)="setMetric('avgReward')"
            >
              Avg Reward
            </button>
            <button
              class="toggle-btn"
              [class.active]="metric() === 'avgDuration'"
              (click)="setMetric('avgDuration')"
            >
              Avg Duration
            </button>
          </div>
        </div>
      </div>
      <div #chartContainer class="chart-area"></div>
      @if (data().length === 0) {
        <div class="empty-state">
          <span class="empty-icon">🗺️</span>
          <span class="empty-text">No agent-task data yet</span>
        </div>
      }
    </div>
  `,
  styles: [`
    .heatmap-container {
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      height: 100%;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    .heatmap-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-sm);
      flex-wrap: wrap;
      gap: var(--spacing-sm);
    }

    .heatmap-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }

    .controls {
      display: flex;
      gap: var(--spacing-sm);
    }

    .metric-toggle {
      display: flex;
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }

    .toggle-btn {
      padding: 4px 8px;
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 9px;
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

    .chart-area {
      flex: 1;
      min-height: 250px;
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
export class AgentTaskHeatmapComponent implements OnDestroy {
  /** Input agent-task metrics */
  data = input<AgentTaskMetric[]>([]);

  /** Chart container reference */
  chartContainer = viewChild<ElementRef<HTMLDivElement>>('chartContainer');

  /** Current metric to display */
  metric = signal<MetricType>('successRate');

  /** ECharts instance */
  private chart: ECharts | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    afterNextRender(() => {
      this.initChart();
    });

    effect(() => {
      const data = this.data();
      const metricType = this.metric();
      this.updateChart(data, metricType);
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.chart?.dispose();
  }

  setMetric(metricType: MetricType): void {
    this.metric.set(metricType);
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

    this.updateChart(this.data(), this.metric());
  }

  private updateChart(data: AgentTaskMetric[], metricType: MetricType): void {
    if (!this.chart) return;

    // Extract unique agents and tasks
    const agents = [...new Set(data.map(d => d.agentId))].sort();
    const tasks = [...new Set(data.map(d => d.taskType))].sort();

    // Create heatmap data and metrics lookup
    const heatmapData: [number, number, number][] = [];
    const metricsLookup = new Map<string, AgentTaskMetric>();

    for (let taskIdx = 0; taskIdx < tasks.length; taskIdx++) {
      for (let agentIdx = 0; agentIdx < agents.length; agentIdx++) {
        const metric = data.find(
          d => d.agentId === agents[agentIdx] && d.taskType === tasks[taskIdx]
        );

        let value = 0;
        if (metric) {
          metricsLookup.set(`${taskIdx}-${agentIdx}`, metric);
          switch (metricType) {
            case 'successRate':
              value = metric.successRate;
              break;
            case 'avgReward':
              value = metric.avgReward;
              break;
            case 'avgDuration':
              // Normalize duration (invert so lower is better shown as green)
              const maxDuration = Math.max(...data.map(d => d.avgDuration), 1);
              value = 1 - (metric.avgDuration / maxDuration);
              break;
          }
        }

        heatmapData.push([taskIdx, agentIdx, value]);
      }
    }

    // Store for tooltip access
    (this as Record<string, unknown>)['_metricsLookup'] = metricsLookup;

    const option: EChartsOption = {
      backgroundColor: 'transparent',
      tooltip: {
        position: 'top',
        backgroundColor: 'rgba(30, 30, 30, 0.95)',
        borderColor: 'var(--border-color)',
        textStyle: {
          color: '#fff',
          fontSize: 11,
        },
        formatter: (params: any) => {
          const [taskIdx, agentIdx] = params.data as [number, number, number];
          const agent = agents[agentIdx];
          const task = tasks[taskIdx];
          const metric = metricsLookup.get(`${taskIdx}-${agentIdx}`);

          if (!metric) {
            return `
              <div style="font-size: 11px;">
                <div style="color: #888;">No data</div>
                <div>Agent: ${agent}</div>
                <div>Task: ${task}</div>
              </div>
            `;
          }

          return `
            <div style="font-size: 11px;">
              <div style="font-weight: 600; margin-bottom: 4px;">${agent} + ${task}</div>
              <div>Success Rate: <strong>${(metric.successRate * 100).toFixed(0)}%</strong></div>
              <div>Avg Reward: <strong>${metric.avgReward.toFixed(3)}</strong></div>
              <div>Avg Duration: <strong>${metric.avgDuration.toFixed(0)}ms</strong></div>
              <div>Samples: <strong>${metric.count}</strong></div>
            </div>
          `;
        },
      },
      grid: {
        height: '60%',
        top: '10%',
        left: 80,
        right: 30,
      },
      xAxis: {
        type: 'category',
        data: tasks,
        splitArea: {
          show: true,
        },
        axisLabel: {
          color: '#888',
          fontSize: 9,
          rotate: 45,
          interval: 0,
        },
        axisLine: {
          lineStyle: { color: '#333' },
        },
      },
      yAxis: {
        type: 'category',
        data: agents,
        splitArea: {
          show: true,
        },
        axisLabel: {
          color: '#888',
          fontSize: 9,
        },
        axisLine: {
          lineStyle: { color: '#333' },
        },
      },
      visualMap: {
        min: 0,
        max: 1,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: '5%',
        inRange: {
          color: ['#d73027', '#fc8d59', '#fee08b', '#d9ef8b', '#91cf60', '#1a9850'],
        },
        textStyle: {
          color: '#888',
          fontSize: 9,
        },
        itemWidth: 15,
        itemHeight: 100,
        text: [this.getMetricLabel(metricType), ''],
      },
      series: [{
        name: 'Performance',
        type: 'heatmap',
        data: heatmapData,
        label: {
          show: true,
          color: '#fff',
          fontSize: 9,
          formatter: (params: any) => {
            const value = params.data[2];
            if (value === 0) return '';
            return metricType === 'avgDuration'
              ? '' // Don't show label for inverted values
              : (value * 100).toFixed(0);
          },
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowColor: 'rgba(0, 0, 0, 0.5)',
          },
        },
        itemStyle: {
          borderColor: '#1a1a1a',
          borderWidth: 1,
        },
      }],
    };

    this.chart.setOption(option, { notMerge: true });
  }

  private getMetricLabel(metricType: MetricType): string {
    switch (metricType) {
      case 'successRate':
        return 'Success Rate';
      case 'avgReward':
        return 'Avg Reward';
      case 'avgDuration':
        return 'Speed (inverted)';
    }
  }
}
