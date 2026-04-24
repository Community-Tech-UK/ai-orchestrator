/**
 * RLM Analytics Component
 *
 * Dashboard for visualizing RLM effectiveness metrics:
 * - Token savings over time (ECharts bar chart)
 * - Token savings trend (ECharts line chart)
 * - Storage breakdown by type (ECharts pie chart)
 * - Query performance statistics
 * - Learning insights
 * - Export to CSV/JSON
 */

import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  effect,
  ChangeDetectionStrategy,
  ElementRef,
  viewChild,
  afterNextRender,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronIpcService } from '../../core/services/ipc';
import * as echarts from 'echarts';
import type { ECharts, EChartsOption } from 'echarts';
import { saveAs } from 'file-saver';

interface TokenSavingsData {
  date: string;
  directTokens: number;
  actualTokens: number;
  savingsPercent: number;
}

interface QueryStats {
  type: string;
  count: number;
  avgDuration: number;
  avgTokens: number;
}

interface StorageStats {
  totalStores: number;
  totalSections: number;
  totalTokens: number;
  totalSizeBytes: number;
  byType: { type: string; count: number; tokens: number }[];
}

interface InsightData {
  id: string;
  type: string;
  title: string;
  description: string;
  confidence: number;
  createdAt: number;
}

interface ExportData {
  exportDate: string;
  timeRange: string;
  tokenSavings: {
    totalSavingsPercent: number;
    totalTokensSaved: number;
    history: TokenSavingsData[];
  };
  queryStats: QueryStats[];
  storageStats: StorageStats | null;
  insights: InsightData[];
}

@Component({
  selector: 'app-rlm-analytics',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './rlm-analytics.component.html',
  styleUrl: './rlm-analytics.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RlmAnalyticsComponent implements OnInit, OnDestroy {
  private ipc = inject(ElectronIpcService);

  timeRange = '30d';

  readonly tokenSavingsHistory = signal<TokenSavingsData[]>([]);
  readonly queryStats = signal<QueryStats[]>([]);
  readonly storageStats = signal<StorageStats | null>(null);
  readonly insights = signal<InsightData[]>([]);
  readonly isLoading = signal<boolean>(false);

  // Chart container references
  tokenBarChartEl = viewChild<ElementRef<HTMLDivElement>>('tokenBarChart');
  savingsTrendChartEl = viewChild<ElementRef<HTMLDivElement>>('savingsTrendChart');
  storagePieChartEl = viewChild<ElementRef<HTMLDivElement>>('storagePieChart');

  // Chart instances
  private tokenBarChart: ECharts | null = null;
  private savingsTrendChart: ECharts | null = null;
  private storagePieChart: ECharts | null = null;
  private resizeObserver: ResizeObserver | null = null;

  readonly totalSavingsPercent = computed(() => {
    const history = this.tokenSavingsHistory();
    if (history.length === 0) return 0;
    const totalDirect = history.reduce((sum, h) => sum + h.directTokens, 0);
    const totalActual = history.reduce((sum, h) => sum + h.actualTokens, 0);
    if (totalDirect === 0) return 0;
    return ((totalDirect - totalActual) / totalDirect) * 100;
  });

  readonly totalTokensSaved = computed(() => {
    const history = this.tokenSavingsHistory();
    const totalDirect = history.reduce((sum, h) => sum + h.directTokens, 0);
    const totalActual = history.reduce((sum, h) => sum + h.actualTokens, 0);
    return totalDirect - totalActual;
  });

  readonly totalQueries = computed(() =>
    this.queryStats().reduce((sum, s) => sum + s.count, 0)
  );

  readonly avgQueryDuration = computed(() => {
    const stats = this.queryStats();
    if (stats.length === 0) return 0;
    const total = stats.reduce((sum, s) => sum + s.avgDuration * s.count, 0);
    const count = stats.reduce((sum, s) => sum + s.count, 0);
    return count > 0 ? total / count : 0;
  });

  readonly highConfidenceInsights = computed(() =>
    this.insights().filter(i => i.confidence >= 0.8).length
  );

  constructor() {
    afterNextRender(() => {
      this.initCharts();
    });

    // Update charts when data changes
    effect(() => {
      const history = this.tokenSavingsHistory();
      this.updateTokenBarChart(history);
      this.updateSavingsTrendChart(history);
    });

    effect(() => {
      const storage = this.storageStats();
      this.updateStoragePieChart(storage);
    });
  }

  ngOnInit(): void {
    this.loadData();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.tokenBarChart?.dispose();
    this.savingsTrendChart?.dispose();
    this.storagePieChart?.dispose();
  }

  private initCharts(): void {
    const tokenBarContainer = this.tokenBarChartEl()?.nativeElement;
    const trendContainer = this.savingsTrendChartEl()?.nativeElement;
    const pieContainer = this.storagePieChartEl()?.nativeElement;

    if (tokenBarContainer) {
      this.tokenBarChart = echarts.init(tokenBarContainer, 'dark', { renderer: 'canvas' });
    }
    if (trendContainer) {
      this.savingsTrendChart = echarts.init(trendContainer, 'dark', { renderer: 'canvas' });
    }
    if (pieContainer) {
      this.storagePieChart = echarts.init(pieContainer, 'dark', { renderer: 'canvas' });
    }

    // Setup resize observer for responsive charts
    this.resizeObserver = new ResizeObserver(() => {
      this.tokenBarChart?.resize();
      this.savingsTrendChart?.resize();
      this.storagePieChart?.resize();
    });

    if (tokenBarContainer) this.resizeObserver.observe(tokenBarContainer);
    if (trendContainer) this.resizeObserver.observe(trendContainer);
    if (pieContainer) this.resizeObserver.observe(pieContainer);

    // Initial chart updates
    this.updateTokenBarChart(this.tokenSavingsHistory());
    this.updateSavingsTrendChart(this.tokenSavingsHistory());
    this.updateStoragePieChart(this.storageStats());
  }

  private updateTokenBarChart(data: TokenSavingsData[]): void {
    if (!this.tokenBarChart || data.length === 0) return;

    const dates = data.map(d => this.formatDateShort(d.date));
    const directTokens = data.map(d => d.directTokens);
    const actualTokens = data.map(d => d.actualTokens);

    const option: EChartsOption = {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(30, 30, 30, 0.95)',
        borderColor: 'var(--border-color)',
        textStyle: { color: '#fff', fontSize: 11 },
        formatter: (params: unknown) => {
          const paramsArray = params as { axisValue: string; value?: number }[];
          const date = paramsArray[0].axisValue;
          const direct = paramsArray[0]?.value || 0;
          const actual = paramsArray[1]?.value || 0;
          const saved = direct - actual;
          const percent = direct > 0 ? ((saved / direct) * 100).toFixed(1) : '0';
          return `
            <div style="font-size: 11px;">
              <div style="font-weight: 600; margin-bottom: 6px;">${date}</div>
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                <span style="display: inline-block; width: 10px; height: 10px; background: #ef4444; border-radius: 2px;"></span>
                Without RLM: <strong>${this.formatNumber(direct)}</strong>
              </div>
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                <span style="display: inline-block; width: 10px; height: 10px; background: #10b981; border-radius: 2px;"></span>
                With RLM: <strong>${this.formatNumber(actual)}</strong>
              </div>
              <div style="border-top: 1px solid #444; padding-top: 4px; margin-top: 4px; color: #10b981;">
                Saved: ${this.formatNumber(saved)} tokens (${percent}%)
              </div>
            </div>
          `;
        },
      },
      legend: {
        data: ['Without RLM', 'With RLM'],
        bottom: 0,
        textStyle: { color: '#888', fontSize: 10 },
        itemWidth: 12,
        itemHeight: 12,
      },
      grid: {
        left: 50,
        right: 20,
        top: 20,
        bottom: 50,
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: { color: '#888', fontSize: 9, rotate: data.length > 10 ? 45 : 0 },
        axisLine: { lineStyle: { color: '#333' } },
      },
      yAxis: {
        type: 'value',
        name: 'Tokens',
        nameTextStyle: { color: '#888', fontSize: 10 },
        axisLabel: {
          color: '#888',
          fontSize: 9,
          formatter: (value: number) => this.formatNumber(value),
        },
        axisLine: { lineStyle: { color: '#333' } },
        splitLine: { lineStyle: { color: '#222' } },
      },
      series: [
        {
          name: 'Without RLM',
          type: 'bar',
          data: directTokens,
          itemStyle: { color: 'rgba(239, 68, 68, 0.7)' },
          barGap: '10%',
        },
        {
          name: 'With RLM',
          type: 'bar',
          data: actualTokens,
          itemStyle: { color: '#10b981' },
        },
      ],
    };

    this.tokenBarChart.setOption(option, { notMerge: true });
  }

  private updateSavingsTrendChart(data: TokenSavingsData[]): void {
    if (!this.savingsTrendChart || data.length === 0) return;

    const dates = data.map(d => this.formatDateShort(d.date));
    const savingsPercent = data.map(d => d.savingsPercent);
    const cumulativeSavings = data.reduce<number[]>((acc, d, i) => {
      const prev = i > 0 ? acc[i - 1] : 0;
      acc.push(prev + (d.directTokens - d.actualTokens));
      return acc;
    }, []);

    const option: EChartsOption = {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(30, 30, 30, 0.95)',
        borderColor: 'var(--border-color)',
        textStyle: { color: '#fff', fontSize: 11 },
        formatter: (params: unknown) => {
          const paramsArray = params as { axisValue: string; value?: number }[];
          const date = paramsArray[0].axisValue;
          const percent = paramsArray[0]?.value || 0;
          const cumulative = paramsArray[1]?.value || 0;
          return `
            <div style="font-size: 11px;">
              <div style="font-weight: 600; margin-bottom: 6px;">${date}</div>
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                <span style="display: inline-block; width: 10px; height: 10px; background: #6366f1; border-radius: 2px;"></span>
                Daily Savings: <strong>${percent.toFixed(1)}%</strong>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="display: inline-block; width: 10px; height: 10px; background: #10b981; border-radius: 2px;"></span>
                Cumulative: <strong>${this.formatNumber(cumulative)}</strong> tokens
              </div>
            </div>
          `;
        },
      },
      legend: {
        data: ['Savings %', 'Cumulative Tokens Saved'],
        bottom: 0,
        textStyle: { color: '#888', fontSize: 10 },
        itemWidth: 12,
        itemHeight: 12,
      },
      grid: {
        left: 50,
        right: 60,
        top: 20,
        bottom: 50,
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: { color: '#888', fontSize: 9, rotate: data.length > 10 ? 45 : 0 },
        axisLine: { lineStyle: { color: '#333' } },
      },
      yAxis: [
        {
          type: 'value',
          name: 'Savings %',
          min: 0,
          max: 100,
          nameTextStyle: { color: '#888', fontSize: 10 },
          axisLabel: {
            color: '#888',
            fontSize: 9,
            formatter: (value: number) => `${value}%`,
          },
          axisLine: { lineStyle: { color: '#333' } },
          splitLine: { lineStyle: { color: '#222' } },
        },
        {
          type: 'value',
          name: 'Tokens',
          nameTextStyle: { color: '#888', fontSize: 10 },
          axisLabel: {
            color: '#888',
            fontSize: 9,
            formatter: (value: number) => this.formatNumber(value),
          },
          axisLine: { lineStyle: { color: '#333' } },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'Savings %',
          type: 'line',
          data: savingsPercent,
          smooth: true,
          lineStyle: { width: 2, color: '#6366f1' },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(99, 102, 241, 0.3)' },
              { offset: 1, color: 'rgba(99, 102, 241, 0.05)' },
            ]),
          },
          symbol: 'circle',
          symbolSize: 6,
          itemStyle: { color: '#6366f1' },
        },
        {
          name: 'Cumulative Tokens Saved',
          type: 'line',
          yAxisIndex: 1,
          data: cumulativeSavings,
          smooth: true,
          lineStyle: { width: 2, color: '#10b981' },
          symbol: 'circle',
          symbolSize: 6,
          itemStyle: { color: '#10b981' },
        },
      ],
    };

    this.savingsTrendChart.setOption(option, { notMerge: true });
  }

  private updateStoragePieChart(storage: StorageStats | null): void {
    if (!this.storagePieChart || !storage || storage.byType.length === 0) return;

    const colors: Record<string, string> = {
      file: '#3b82f6',
      conversation: '#10b981',
      tool_output: '#f59e0b',
      external: '#8b5cf6',
      summary: '#ef4444',
    };

    const data = storage.byType.map(t => ({
      name: this.formatSectionType(t.type),
      value: t.tokens,
      itemStyle: { color: colors[t.type] || '#888' },
    }));

    const option: EChartsOption = {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(30, 30, 30, 0.95)',
        borderColor: 'var(--border-color)',
        textStyle: { color: '#fff', fontSize: 11 },
        formatter: (params: unknown) => {
          const paramObj = params as { name: string; value: number; percent: number };
          const item = storage.byType.find(t => this.formatSectionType(t.type) === paramObj.name);
          return `
            <div style="font-size: 11px;">
              <div style="font-weight: 600; margin-bottom: 4px;">${paramObj.name}</div>
              <div>${this.formatNumber(paramObj.value)} tokens (${paramObj.percent}%)</div>
              <div style="color: #888;">${item?.count || 0} sections</div>
            </div>
          `;
        },
      },
      legend: {
        orient: 'vertical',
        right: 10,
        top: 'center',
        textStyle: { color: '#888', fontSize: 9 },
        itemWidth: 10,
        itemHeight: 10,
      },
      series: [{
        type: 'pie',
        radius: ['45%', '75%'],
        center: ['35%', '50%'],
        avoidLabelOverlap: false,
        label: { show: false },
        labelLine: { show: false },
        emphasis: {
          label: {
            show: true,
            fontSize: 11,
            fontWeight: 'bold',
          },
        },
        data,
      }],
    };

    this.storagePieChart.setOption(option, { notMerge: true });
  }

  async loadData(): Promise<void> {
    this.isLoading.set(true);
    try {
      await Promise.all([
        this.loadTokenSavings(),
        this.loadQueryStats(),
        this.loadStorageStats(),
        this.loadInsights(),
      ]);
    } finally {
      this.isLoading.set(false);
    }
  }

  private async loadTokenSavings(): Promise<void> {
    try {
      const response = await this.ipc.getApi()?.rlmGetTokenSavingsHistory({
        range: this.timeRange,
      });
      if (response?.success && response.data) {
        this.tokenSavingsHistory.set(response.data as TokenSavingsData[]);
      }
    } catch (error) {
      console.error('[RLM Analytics] Failed to load token savings:', error);
    }
  }

  private async loadQueryStats(): Promise<void> {
    try {
      const response = await this.ipc.getApi()?.rlmGetQueryStats({
        range: this.timeRange,
      });
      if (response?.success && response.data) {
        this.queryStats.set(response.data as QueryStats[]);
      }
    } catch (error) {
      console.error('[RLM Analytics] Failed to load query stats:', error);
    }
  }

  private async loadStorageStats(): Promise<void> {
    try {
      const response = await this.ipc.getApi()?.rlmGetStorageStats();
      if (response?.success && response.data) {
        this.storageStats.set(response.data as StorageStats);
      }
    } catch (error) {
      console.error('[RLM Analytics] Failed to load storage stats:', error);
    }
  }

  private async loadInsights(): Promise<void> {
    try {
      const response = await this.ipc.getApi()?.learningGetInsights();
      if (response?.success && response.data) {
        this.insights.set(response.data as InsightData[]);
      }
    } catch (error) {
      console.error('[RLM Analytics] Failed to load insights:', error);
    }
  }

  exportCSV(): void {
    const data = this.buildExportData();
    const sections: string[] = [];

    // Header
    sections.push(`# RLM Analytics Export`);
    sections.push(`# Date Range: ${this.getTimeRangeLabel()}`);
    sections.push(`# Export Date: ${data.exportDate}`);
    sections.push('');

    // Summary
    sections.push('# Summary');
    sections.push('Metric,Value');
    sections.push(`Total Savings Percent,${data.tokenSavings.totalSavingsPercent.toFixed(2)}%`);
    sections.push(`Total Tokens Saved,${data.tokenSavings.totalTokensSaved}`);
    sections.push('');

    // Token Savings History
    if (data.tokenSavings.history.length > 0) {
      sections.push('# Token Savings History');
      sections.push('Date,Direct Tokens,Actual Tokens,Savings Percent');
      for (const h of data.tokenSavings.history) {
        sections.push(`${h.date},${h.directTokens},${h.actualTokens},${h.savingsPercent.toFixed(2)}%`);
      }
      sections.push('');
    }

    // Query Stats
    if (data.queryStats.length > 0) {
      sections.push('# Query Statistics');
      sections.push('Type,Count,Avg Duration (ms),Avg Tokens');
      for (const q of data.queryStats) {
        sections.push(`${q.type},${q.count},${q.avgDuration.toFixed(2)},${q.avgTokens.toFixed(2)}`);
      }
      sections.push('');
    }

    // Storage Stats
    if (data.storageStats) {
      sections.push('# Storage Statistics');
      sections.push(`Total Stores,${data.storageStats.totalStores}`);
      sections.push(`Total Sections,${data.storageStats.totalSections}`);
      sections.push(`Total Tokens,${data.storageStats.totalTokens}`);
      sections.push(`Total Size (bytes),${data.storageStats.totalSizeBytes}`);
      sections.push('');

      if (data.storageStats.byType.length > 0) {
        sections.push('# Storage by Type');
        sections.push('Type,Count,Tokens');
        for (const t of data.storageStats.byType) {
          sections.push(`${t.type},${t.count},${t.tokens}`);
        }
        sections.push('');
      }
    }

    // Insights
    if (data.insights.length > 0) {
      sections.push('# Insights');
      sections.push('ID,Type,Title,Description,Confidence,Created At');
      for (const i of data.insights) {
        const desc = i.description ? `"${i.description.replace(/"/g, '""')}"` : '';
        sections.push(`${i.id},${i.type},"${i.title.replace(/"/g, '""')}",${desc},${(i.confidence * 100).toFixed(0)}%,${new Date(i.createdAt).toISOString()}`);
      }
    }

    const csv = sections.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, `rlm-analytics-${this.timeRange}-${this.getTimestamp()}.csv`);
  }

  exportJSON(): void {
    const data = this.buildExportData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    saveAs(blob, `rlm-analytics-${this.timeRange}-${this.getTimestamp()}.json`);
  }

  private buildExportData(): ExportData {
    return {
      exportDate: new Date().toISOString(),
      timeRange: this.getTimeRangeLabel(),
      tokenSavings: {
        totalSavingsPercent: this.totalSavingsPercent(),
        totalTokensSaved: this.totalTokensSaved(),
        history: this.tokenSavingsHistory(),
      },
      queryStats: this.queryStats(),
      storageStats: this.storageStats(),
      insights: this.insights(),
    };
  }

  private getTimeRangeLabel(): string {
    switch (this.timeRange) {
      case '7d': return 'Last 7 days';
      case '30d': return 'Last 30 days';
      case '90d': return 'Last 90 days';
      default: return this.timeRange;
    }
  }

  private getTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  }

  formatNumber(n: number): string {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
  }

  formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
  }

  formatDateShort(date: string): string {
    return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  formatSectionType(type: string): string {
    switch (type) {
      case 'file': return 'Files';
      case 'conversation': return 'Conversations';
      case 'tool_output': return 'Tool Output';
      case 'external': return 'External';
      case 'summary': return 'Summaries';
      default: return type.charAt(0).toUpperCase() + type.slice(1);
    }
  }

  getQueryTypeIcon(type: string): string {
    switch (type) {
      case 'grep': return '🔍';
      case 'slice': return '✂️';
      case 'sub_query': return '🔄';
      case 'summarize': return '📝';
      case 'get_section': return '📄';
      case 'semantic_search': return '🎯';
      default: return '❓';
    }
  }

  getSectionTypeIcon(type: string): string {
    switch (type) {
      case 'file': return '📁';
      case 'conversation': return '💬';
      case 'tool_output': return '🔧';
      case 'external': return '🌐';
      case 'summary': return '📋';
      default: return '📄';
    }
  }
}
