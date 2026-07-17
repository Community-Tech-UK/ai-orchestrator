import {
  Component, input, output, ChangeDetectionStrategy,
  ElementRef, viewChild, afterNextRender, OnDestroy, effect
} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as echarts from 'echarts';
import type { ECharts, EChartsOption } from 'echarts';

// Register Mission Control theme once
const MISSION_CONTROL_THEME = {
  color: ['#d9a13d', '#4fa3a5', '#4aa06f', '#d05f4e', '#5b8dbf', '#b89a66', '#8ca594', '#b8865f'],
  backgroundColor: 'transparent',
  textStyle: { color: '#c4c4c9', fontFamily: 'IBM Plex Sans, sans-serif' },
  title: { textStyle: { color: '#fafaf9' }, subtextStyle: { color: '#9a9aa0' } },
  legend: { textStyle: { color: '#c4c4c9' } },
  tooltip: {
    backgroundColor: '#18181b', borderColor: '#2a2a2e', textStyle: { color: '#fafaf9' },
    extraCssText: 'border-radius: 8px; box-shadow: 0 4px 24px rgba(0,0,0,0.5);'
  },
  categoryAxis: {
    axisLine: { lineStyle: { color: '#2a2a2e' } },
    axisTick: { lineStyle: { color: '#2a2a2e' } },
    axisLabel: { color: '#9a9aa0' },
    splitLine: { lineStyle: { color: '#1a1a1e' } }
  },
  valueAxis: {
    axisLine: { lineStyle: { color: '#2a2a2e' } },
    axisTick: { lineStyle: { color: '#2a2a2e' } },
    axisLabel: { color: '#9a9aa0' },
    splitLine: { lineStyle: { color: '#1a1a1e' } }
  }
};
echarts.registerTheme('mission-control', MISSION_CONTROL_THEME);

@Component({
  selector: 'app-echarts-themed',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-wrapper" [style.height]="height()">
      @if (loading()) {
        <div class="chart-loading">
          <div class="loading-spinner"></div>
          <span>Loading chart...</span>
        </div>
      } @else if (!options()) {
        <div class="chart-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 3v18h18M7 16l4-4 4 4 4-6"/>
          </svg>
          <span>{{ emptyMessage() }}</span>
        </div>
      }
      <div #chartContainer class="chart-container" [class.hidden]="loading() || !options()"></div>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; }
    .chart-wrapper {
      position: relative; width: 100%; border-radius: var(--radius-md, 8px);
      background: var(--bg-secondary, #0c0c0f); overflow: hidden;
    }
    .chart-container { width: 100%; height: 100%; }
    .chart-container.hidden { visibility: hidden; position: absolute; }
    .chart-loading, .chart-empty {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: var(--spacing-sm, 8px);
      color: var(--text-muted, #9a9aa0); font-size: 0.875rem;
    }
    .loading-spinner {
      width: 32px; height: 32px; border: 2px solid var(--bg-tertiary, #111114);
      border-top-color: var(--primary-color, #f59e0b); border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `]
})
export class EchartsThemedComponent implements OnDestroy {
  readonly options = input<EChartsOption | null>(null);
  readonly loading = input(false);
  readonly height = input('300px');
  readonly emptyMessage = input('No data available');
  readonly chartClick = output<unknown>();
  readonly chartInit = output<ECharts>();

  private chartContainer = viewChild<ElementRef<HTMLDivElement>>('chartContainer');
  private chart: ECharts | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    afterNextRender(() => { this.initChart(); });
    effect(() => {
      const opts = this.options();
      if (this.chart && opts) {
        this.chart.setOption(opts, { notMerge: true });
      }
    });
  }

  private initChart(): void {
    const el = this.chartContainer()?.nativeElement;
    if (!el) return;
    this.chart = echarts.init(el, 'mission-control', { renderer: 'canvas' });
    this.chart.on('click', (params) => this.chartClick.emit(params));
    this.chartInit.emit(this.chart);
    this.resizeObserver = new ResizeObserver(() => this.chart?.resize());
    this.resizeObserver.observe(el);
    const opts = this.options();
    if (opts) this.chart.setOption(opts, { notMerge: true });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.chart?.dispose();
  }
}
