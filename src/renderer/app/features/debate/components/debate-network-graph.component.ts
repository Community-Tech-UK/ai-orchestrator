/**
 * Debate Network Graph Component
 *
 * Visualize critique relationships between agents:
 * - Nodes represent agents (sized by confidence)
 * - Edges represent critiques (colored by severity)
 * - Green dashed lines for agreements
 * - Interactive hover and click
 */

import {
  Component,
  input,
  output,
  effect,
  ChangeDetectionStrategy,
  ElementRef,
  viewChild,
  OnDestroy,
  afterNextRender,
} from '@angular/core';
import * as echarts from 'echarts';
import type { ECharts, EChartsOption } from 'echarts';
import type { DebateContribution, AgentCritique } from '../../../../../shared/types/debate.types';

export interface NetworkNode {
  id?: string;
  agentId: string;
  label?: string;
  confidence: number;
  contributionCount?: number;
  position?: string;
}

export interface NetworkLink {
  source: string;
  target: string;
  type: 'critique_major' | 'critique_minor' | 'critique_suggestion' | 'agreement' | 'critique' | 'refinement';
  issue?: string;
  weight?: number;
}

@Component({
  selector: 'app-debate-network-graph',
  standalone: true,
  template: `
    <div class="graph-container">
      <div class="graph-header">
        <h3 class="graph-title">Agent Interaction Network</h3>
        <div class="legend">
          <span class="legend-item">
            <span class="legend-dot major"></span> Major Critique
          </span>
          <span class="legend-item">
            <span class="legend-dot minor"></span> Minor Critique
          </span>
          <span class="legend-item">
            <span class="legend-dot suggestion"></span> Suggestion
          </span>
          <span class="legend-item">
            <span class="legend-line agreement"></span> Agreement
          </span>
        </div>
      </div>
      <div #chartContainer class="chart-area"></div>
      @if (nodes().length === 0) {
        <div class="empty-state">
          <span class="empty-icon">🕸️</span>
          <span class="empty-text">No interaction data yet</span>
        </div>
      }
    </div>
  `,
  styles: [`
    .graph-container {
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      height: 100%;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    .graph-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-sm);
      flex-wrap: wrap;
      gap: var(--spacing-sm);
    }

    .graph-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }

    .legend {
      display: flex;
      gap: var(--spacing-md);
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      color: var(--text-muted);
    }

    .legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;

      &.major { background: #ef4444; }
      &.minor { background: #f59e0b; }
      &.suggestion { background: #3b82f6; }
    }

    .legend-line {
      width: 16px;
      height: 2px;
      background: repeating-linear-gradient(
        90deg,
        #10b981 0px,
        #10b981 3px,
        transparent 3px,
        transparent 6px
      );

      &.agreement { }
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
export class DebateNetworkGraphComponent implements OnDestroy {
  /** Input nodes */
  nodes = input<NetworkNode[]>([]);

  /** Input links */
  links = input<NetworkLink[]>([]);

  /** Node click event */
  nodeClick = output<string>();

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
      const nodes = this.nodes();
      const links = this.links();
      this.updateChart(nodes, links);
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.chart?.dispose();
  }

  private initChart(): void {
    const container = this.chartContainer()?.nativeElement;
    if (!container) return;

    this.chart = echarts.init(container, 'dark', {
      renderer: 'canvas',
    });

    this.chart.on('click', 'series.graph', (params: any) => {
      if (params.dataType === 'node') {
        this.nodeClick.emit(params.data.name);
      }
    });

    this.resizeObserver = new ResizeObserver(() => {
      this.chart?.resize();
    });
    this.resizeObserver.observe(container);

    this.updateChart(this.nodes(), this.links());
  }

  private updateChart(nodes: NetworkNode[], links: NetworkLink[]): void {
    if (!this.chart) return;

    const colors: Record<string, string> = {
      critique_major: '#ef4444',
      critique_minor: '#f59e0b',
      critique_suggestion: '#3b82f6',
      agreement: '#10b981',
      critique: '#ef4444',
      refinement: '#8b5cf6',
    };

    const agentColors = ['#6366f1', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

    const chartNodes = nodes.map((node, index) => ({
      name: node.agentId,
      value: node.confidence,
      symbolSize: 30 + node.confidence * 30,
      itemStyle: {
        color: agentColors[index % agentColors.length],
        borderColor: '#fff',
        borderWidth: 2,
      },
      label: {
        show: true,
        position: 'bottom' as const,
        fontSize: 10,
        color: '#888',
      },
    }));

    const chartLinks = links.map(link => ({
      source: link.source,
      target: link.target,
      lineStyle: {
        color: colors[link.type] || '#888',
        width: link.type.includes('major') ? 3 : 2,
        type: (link.type === 'agreement' ? 'dashed' : 'solid') as 'solid' | 'dashed',
        curveness: 0.2,
      },
      emphasis: {
        lineStyle: {
          width: 4,
        },
      },
    }));

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
        formatter: (params: any) => {
          if (params.dataType === 'node') {
            const node = nodes.find(n => n.agentId === params.name);
            return `
              <div style="font-size: 11px;">
                <div style="font-weight: 600; margin-bottom: 4px;">${params.name}</div>
                <div>Confidence: ${((node?.confidence || 0) * 100).toFixed(0)}%</div>
                <div>Contributions: ${node?.contributionCount || 0}</div>
              </div>
            `;
          } else if (params.dataType === 'edge') {
            const link = links.find(l =>
              l.source === params.data.source && l.target === params.data.target
            );
            const typeLabel = link?.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            return `
              <div style="font-size: 11px;">
                <div style="font-weight: 600; margin-bottom: 4px;">${params.data.source} → ${params.data.target}</div>
                <div>Type: ${typeLabel}</div>
                ${link?.issue ? `<div style="margin-top: 4px;">${link.issue}</div>` : ''}
              </div>
            `;
          }
          return '';
        },
      },
      animationDuration: 1500,
      animationEasingUpdate: 'quinticInOut',
      series: [{
        type: 'graph',
        layout: 'force',
        data: chartNodes,
        links: chartLinks,
        roam: true,
        draggable: true,
        force: {
          repulsion: 300,
          edgeLength: [100, 200],
          gravity: 0.1,
        },
        emphasis: {
          focus: 'adjacency',
          itemStyle: {
            shadowBlur: 10,
            shadowColor: 'rgba(0, 0, 0, 0.3)',
          },
        },
        lineStyle: {
          opacity: 0.8,
        },
        label: {
          show: true,
          position: 'bottom',
          formatter: '{b}',
          fontSize: 10,
          color: '#888',
        },
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: 8,
      }],
    };

    this.chart.setOption(option, { notMerge: true });
  }
}
