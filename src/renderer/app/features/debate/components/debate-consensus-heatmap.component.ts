/**
 * Debate Consensus Heatmap Component
 *
 * Visualize agreement/disagreement across topics:
 * - X-axis: Topics extracted from debate
 * - Y-axis: Agents
 * - Color: Green (agreement) to Red (disagreement)
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

export interface TopicConsensus {
  topic: string;
  agentId: string;
  stance: number; // -1 (strong disagree) to 1 (strong agree)
  confidence: number;
}

@Component({
  selector: 'app-debate-consensus-heatmap',
  standalone: true,
  template: `
    <div class="heatmap-container">
      <div class="heatmap-header">
        <h3 class="heatmap-title">Topic Consensus Matrix</h3>
        <div class="summary">
          @if (data().length > 0) {
            <span class="summary-item">
              {{ getTopicCount() }} topics
            </span>
            <span class="summary-item">
              {{ getAgentCount() }} agents
            </span>
          }
        </div>
      </div>
      <div #chartContainer class="chart-area"></div>
      @if (data().length === 0) {
        <div class="empty-state">
          <span class="empty-icon">🔥</span>
          <span class="empty-text">No consensus data yet</span>
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
    }

    .heatmap-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }

    .summary {
      display: flex;
      gap: var(--spacing-md);
    }

    .summary-item {
      font-size: 10px;
      color: var(--text-muted);
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
export class DebateConsensusHeatmapComponent implements OnDestroy {
  /** Input consensus data */
  data = input<TopicConsensus[]>([]);

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

  getTopicCount(): number {
    return new Set(this.data().map(d => d.topic)).size;
  }

  getAgentCount(): number {
    return new Set(this.data().map(d => d.agentId)).size;
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

  private updateChart(data: TopicConsensus[]): void {
    if (!this.chart) return;

    const topics = [...new Set(data.map(d => d.topic))];
    const agents = [...new Set(data.map(d => d.agentId))];

    // Create heatmap data (only [x, y, value] for ECharts compatibility)
    const heatmapData: [number, number, number][] = [];
    // Lookup map for tooltip access
    const itemLookup = new Map<string, TopicConsensus | null>();

    for (let topicIdx = 0; topicIdx < topics.length; topicIdx++) {
      for (let agentIdx = 0; agentIdx < agents.length; agentIdx++) {
        const item = data.find(
          d => d.topic === topics[topicIdx] && d.agentId === agents[agentIdx]
        );

        heatmapData.push([
          topicIdx,
          agentIdx,
          item?.stance ?? 0,
        ]);
        itemLookup.set(`${topicIdx}-${agentIdx}`, item ?? null);
      }
    }

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
          const [topicIdx, agentIdx, stance] = params.data;
          const topic = topics[topicIdx];
          const agent = agents[agentIdx];
          const item = itemLookup.get(`${topicIdx}-${agentIdx}`);

          if (!item) {
            return `
              <div style="font-size: 11px;">
                <div style="color: #888;">No data</div>
                <div>Agent: ${agent}</div>
                <div>Topic: ${topic}</div>
              </div>
            `;
          }

          const stanceLabel = stance > 0.5 ? 'Strong Agree' :
                             stance > 0 ? 'Agree' :
                             stance > -0.5 ? 'Disagree' : 'Strong Disagree';

          return `
            <div style="font-size: 11px;">
              <div style="font-weight: 600; margin-bottom: 4px;">${agent}</div>
              <div style="color: #888; margin-bottom: 4px;">${topic}</div>
              <div>Stance: <strong>${stanceLabel}</strong></div>
              <div>Confidence: ${(item.confidence * 100).toFixed(0)}%</div>
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
        data: topics.map(t => this.truncateTopic(t)),
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
        min: -1,
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
        text: ['Agree', 'Disagree'],
      },
      series: [{
        name: 'Consensus',
        type: 'heatmap',
        data: heatmapData,
        label: {
          show: true,
          color: '#fff',
          fontSize: 9,
          formatter: (params: any) => {
            const value = params.data[2];
            if (value === 0) return '';
            if (value > 0.5) return '++';
            if (value > 0) return '+';
            if (value > -0.5) return '-';
            return '--';
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

  private truncateTopic(topic: string): string {
    if (topic.length > 15) {
      return topic.substring(0, 12) + '...';
    }
    return topic;
  }
}
