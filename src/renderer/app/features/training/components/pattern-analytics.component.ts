/**
 * Pattern Analytics Component
 *
 * Visualize learned patterns and their effectiveness:
 * - Pie chart for pattern type distribution
 * - Top patterns table with trend indicators
 * - Anti-pattern warnings section
 */

import {
  Component,
  input,
  computed,
  effect,
  ChangeDetectionStrategy,
  ElementRef,
  viewChild,
  OnDestroy,
  afterNextRender,
} from '@angular/core';
import * as echarts from 'echarts';
import type { ECharts, EChartsOption } from 'echarts';

export interface PatternData {
  id: string;
  type: 'tool_sequence' | 'agent_task_pairing' | 'model_task_pairing' | 'prompt_structure' | 'error_recovery';
  pattern: string;
  effectiveness: number;
  confidence: number;
  appliedCount: number;
  trendData: number[];
  isAntiPattern: boolean;
}

@Component({
  selector: 'app-pattern-analytics',
  standalone: true,
  template: `
    <div class="analytics-container">
      <div class="analytics-header">
        <h3 class="analytics-title">Pattern Analytics</h3>
        <div class="summary">
          <span class="summary-item">
            {{ patterns().length }} patterns
          </span>
          <span class="summary-item warning">
            {{ antiPatterns().length }} anti-patterns
          </span>
        </div>
      </div>

      <div class="analytics-content">
        <!-- Distribution Chart -->
        <div class="chart-section">
          <div #chartContainer class="chart-area"></div>
        </div>

        <!-- Top Patterns -->
        <div class="patterns-section">
          <h4 class="section-title">Top Performing Patterns</h4>
          <div class="patterns-list">
            @for (pattern of topPatterns(); track pattern.id) {
              <div class="pattern-card">
                <div class="pattern-header">
                  <span class="pattern-type-badge" [class]="'type-' + pattern.type">
                    {{ getPatternTypeIcon(pattern.type) }} {{ formatPatternType(pattern.type) }}
                  </span>
                  <span class="effectiveness">{{ (pattern.effectiveness * 100).toFixed(0) }}%</span>
                </div>
                <div class="pattern-description">{{ pattern.pattern }}</div>
                <div class="pattern-stats">
                  <span class="stat">Applied: {{ pattern.appliedCount }}x</span>
                  <span class="stat">Confidence: {{ (pattern.confidence * 100).toFixed(0) }}%</span>
                </div>
                <div class="pattern-trend">
                  <svg viewBox="0 0 100 30" class="trend-line">
                    @if (pattern.trendData.length > 1) {
                      <polyline
                        [attr.points]="getTrendPoints(pattern.trendData)"
                        fill="none"
                        [attr.stroke]="getTrendColor(pattern.trendData)"
                        stroke-width="2"
                      />
                    }
                  </svg>
                </div>
              </div>
            }

            @if (topPatterns().length === 0) {
              <div class="empty-state-small">
                <span class="empty-text">No patterns discovered yet</span>
              </div>
            }
          </div>
        </div>

        <!-- Anti-Patterns -->
        @if (antiPatterns().length > 0) {
          <div class="anti-patterns-section">
            <h4 class="section-title warning">
              <span class="warning-icon">⚠️</span>
              Anti-Patterns Detected
            </h4>
            <div class="anti-patterns-list">
              @for (pattern of antiPatterns(); track pattern.id) {
                <div class="anti-pattern-card">
                  <span class="pattern-type-badge" [class]="'type-' + pattern.type">
                    {{ formatPatternType(pattern.type) }}
                  </span>
                  <span class="pattern-text">{{ pattern.pattern }}</span>
                  <span class="failure-rate">{{ ((1 - pattern.effectiveness) * 100).toFixed(0) }}% failure</span>
                </div>
              }
            </div>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .analytics-container {
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .analytics-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-sm);
    }

    .analytics-title {
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

      &.warning {
        color: #f59e0b;
      }
    }

    .analytics-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      overflow: hidden;
    }

    .chart-section {
      height: 150px;
    }

    .chart-area {
      height: 100%;
    }

    .patterns-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .section-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      margin: 0 0 var(--spacing-xs) 0;

      &.warning {
        color: #f59e0b;
        display: flex;
        align-items: center;
        gap: 4px;
      }
    }

    .warning-icon {
      font-size: 12px;
    }

    .patterns-list {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .pattern-card {
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
    }

    .pattern-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }

    .pattern-type-badge {
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      font-size: 8px;
      font-weight: 600;

      &.type-tool_sequence { background: rgba(59, 130, 246, 0.2); color: #3b82f6; }
      &.type-agent_task_pairing { background: rgba(16, 185, 129, 0.2); color: #10b981; }
      &.type-model_task_pairing { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
      &.type-prompt_structure { background: rgba(139, 92, 246, 0.2); color: #8b5cf6; }
      &.type-error_recovery { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
    }

    .effectiveness {
      font-size: 11px;
      font-weight: 600;
      color: #10b981;
    }

    .pattern-description {
      font-size: 10px;
      color: var(--text-primary);
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .pattern-stats {
      display: flex;
      gap: var(--spacing-sm);
      margin-bottom: 4px;
    }

    .stat {
      font-size: 9px;
      color: var(--text-muted);
    }

    .pattern-trend {
      height: 20px;
    }

    .trend-line {
      width: 100%;
      height: 100%;
    }

    .anti-patterns-section {
      max-height: 100px;
      overflow-y: auto;
    }

    .anti-patterns-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .anti-pattern-card {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
      background: rgba(239, 68, 68, 0.1);
      border-left: 2px solid #ef4444;
      border-radius: var(--radius-sm);
    }

    .pattern-text {
      flex: 1;
      font-size: 10px;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .failure-rate {
      font-size: 10px;
      font-weight: 600;
      color: #ef4444;
    }

    .empty-state-small {
      padding: var(--spacing-md);
      text-align: center;
    }

    .empty-text {
      font-size: 11px;
      color: var(--text-muted);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PatternAnalyticsComponent implements OnDestroy {
  /** Input patterns */
  patterns = input<PatternData[]>([]);

  /** Chart container reference */
  chartContainer = viewChild<ElementRef<HTMLDivElement>>('chartContainer');

  /** Top performing patterns (non-anti) */
  topPatterns = computed(() => {
    return this.patterns()
      .filter(p => !p.isAntiPattern)
      .sort((a, b) => b.effectiveness - a.effectiveness)
      .slice(0, 5);
  });

  /** Anti-patterns */
  antiPatterns = computed(() => {
    return this.patterns()
      .filter(p => p.isAntiPattern)
      .sort((a, b) => a.effectiveness - b.effectiveness);
  });

  /** ECharts instance */
  private chart: ECharts | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    afterNextRender(() => {
      this.initChart();
    });

    effect(() => {
      const patterns = this.patterns();
      this.updateChart(patterns);
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.chart?.dispose();
  }

  getPatternTypeIcon(type: string): string {
    switch (type) {
      case 'tool_sequence': return '🔧';
      case 'agent_task_pairing': return '🤖';
      case 'model_task_pairing': return '🧠';
      case 'prompt_structure': return '📝';
      case 'error_recovery': return '🔄';
      default: return '❓';
    }
  }

  formatPatternType(type: string): string {
    return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  getTrendPoints(data: number[]): string {
    if (data.length < 2) return '';

    const max = Math.max(...data, 0.01);
    const min = Math.min(...data, 0);
    const range = max - min || 1;

    return data.map((value, index) => {
      const x = (index / (data.length - 1)) * 100;
      const y = 30 - ((value - min) / range) * 25;
      return `${x},${y}`;
    }).join(' ');
  }

  getTrendColor(data: number[]): string {
    if (data.length < 2) return '#888';

    const first = data[0];
    const last = data[data.length - 1];
    const change = last - first;

    if (change > 0.05) return '#10b981'; // Improving
    if (change < -0.05) return '#ef4444'; // Declining
    return '#888'; // Stable
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

    this.updateChart(this.patterns());
  }

  private updateChart(patterns: PatternData[]): void {
    if (!this.chart) return;

    // Count patterns by type
    const typeCounts = patterns
      .filter(p => !p.isAntiPattern)
      .reduce((acc, p) => {
        acc[p.type] = (acc[p.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    const colors: Record<string, string> = {
      tool_sequence: '#3b82f6',
      agent_task_pairing: '#10b981',
      model_task_pairing: '#f59e0b',
      prompt_structure: '#8b5cf6',
      error_recovery: '#ef4444',
    };

    const data = Object.entries(typeCounts).map(([type, count]) => ({
      name: this.formatPatternType(type),
      value: count,
      itemStyle: { color: colors[type] || '#888' },
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
        formatter: '{b}: {c} ({d}%)',
      },
      legend: {
        orient: 'vertical',
        right: 10,
        top: 'center',
        textStyle: {
          color: '#888',
          fontSize: 9,
        },
        itemWidth: 10,
        itemHeight: 10,
      },
      series: [{
        type: 'pie',
        radius: ['40%', '70%'],
        center: ['35%', '50%'],
        avoidLabelOverlap: false,
        label: {
          show: false,
        },
        labelLine: {
          show: false,
        },
        emphasis: {
          label: {
            show: true,
            fontSize: 10,
            fontWeight: 'bold',
          },
        },
        data,
      }],
    };

    this.chart.setOption(option, { notMerge: true });
  }
}
