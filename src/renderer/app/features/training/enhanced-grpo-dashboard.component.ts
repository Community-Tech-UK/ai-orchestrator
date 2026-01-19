/**
 * Enhanced GRPO Training Dashboard Component
 *
 * TensorBoard-like training monitoring with:
 * - Real-time reward charts
 * - Advantage histograms
 * - Strategy comparison
 * - Agent-task performance heatmap
 * - Pattern analytics
 * - Learning insights feed
 * - Configuration panel
 * - Export functionality
 */

import {
  Component,
  signal,
  computed,
  inject,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
} from '@angular/core';
import { SlicePipe } from '@angular/common';
import { Subject, interval } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

// Import chart components
import { RewardTrendChartComponent, type RewardDataPoint } from './components/reward-trend-chart.component';
import { AdvantageHistogramComponent, type AdvantageDataPoint } from './components/advantage-histogram.component';
import { StrategyComparisonComponent, type StrategyPerformance } from './components/strategy-comparison.component';
import { AgentTaskHeatmapComponent, type AgentTaskMetric } from './components/agent-task-heatmap.component';
import { PatternAnalyticsComponent, type PatternData } from './components/pattern-analytics.component';
import { LearningInsightsFeedComponent, type LearningInsight } from './components/learning-insights-feed.component';
import { GrpoConfigPanelComponent, type GRPOConfig } from './components/grpo-config-panel.component';
import { TrainingExportService } from './services/training-export.service';
import { ElectronIpcService } from '../../core/services/electron-ipc.service';

/** Pattern distribution data for charts */
export interface PatternTypeDistribution {
  type: string;
  count: number;
  percentage: number;
}

type DashboardTab = 'overview' | 'strategies' | 'patterns' | 'insights' | 'config';

interface DashboardStats {
  totalEpisodes: number;
  totalSteps: number;
  averageReward: number;
  maxReward: number;
  minReward: number;
  successRate: number;
  averageAdvantage: number;
  learningRate: number;
  lastUpdated: number;
}

@Component({
  selector: 'app-enhanced-grpo-dashboard',
  standalone: true,
  imports: [
    SlicePipe,
    RewardTrendChartComponent,
    AdvantageHistogramComponent,
    StrategyComparisonComponent,
    AgentTaskHeatmapComponent,
    PatternAnalyticsComponent,
    LearningInsightsFeedComponent,
    GrpoConfigPanelComponent,
  ],
  template: `
    <div class="dashboard-container">
      <!-- Header -->
      <div class="dashboard-header">
        <div class="header-left">
          <span class="dashboard-icon">🎯</span>
          <h1 class="dashboard-title">GRPO Training Dashboard</h1>
          <span class="training-badge" [class.active]="isTrainingActive()">
            {{ isTrainingActive() ? 'Learning Active' : 'Idle' }}
          </span>
        </div>
        <div class="header-actions">
          <button class="action-btn" (click)="toggleAutoRefresh()">
            {{ autoRefresh() ? '⏸️ Pause' : '▶️ Auto' }}
          </button>
          <button class="action-btn" (click)="refreshData()">
            🔄 Refresh
          </button>
          <div class="export-dropdown">
            <button class="action-btn export-btn" (click)="toggleExportMenu()">
              📥 Export
            </button>
            @if (showExportMenu()) {
              <div class="export-menu">
                <button (click)="exportData('json')">JSON</button>
                <button (click)="exportData('csv')">CSV</button>
                <button (click)="exportData('pdf')">PDF Report</button>
              </div>
            }
          </div>
        </div>
      </div>

      <!-- Tab Navigation -->
      <div class="tab-navigation">
        @for (tab of tabs; track tab.id) {
          <button
            class="tab-btn"
            [class.active]="activeTab() === tab.id"
            (click)="setActiveTab(tab.id)"
          >
            <span class="tab-icon">{{ tab.icon }}</span>
            {{ tab.label }}
          </button>
        }
      </div>

      <!-- Stats Overview (Always Visible) -->
      @if (stats(); as s) {
        <div class="stats-overview">
          <div class="stat-card">
            <span class="stat-value">{{ formatNumber(s.totalEpisodes) }}</span>
            <span class="stat-label">Episodes</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">{{ (s.successRate * 100).toFixed(1) }}%</span>
            <span class="stat-label">Success Rate</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">{{ s.averageReward.toFixed(3) }}</span>
            <span class="stat-label">Avg Reward</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">{{ s.averageAdvantage.toFixed(3) }}</span>
            <span class="stat-label">Avg Advantage</span>
          </div>
          <div class="stat-card highlight">
            <span class="stat-value">{{ s.learningRate.toExponential(1) }}</span>
            <span class="stat-label">Learning Rate</span>
          </div>
        </div>
      }

      <!-- Tab Content -->
      <div class="tab-content">
        @switch (activeTab()) {
          @case ('overview') {
            <div class="overview-grid">
              <!-- Reward Trend Chart -->
              <div class="chart-panel reward-chart">
                <app-reward-trend-chart
                  [data]="rewardData()"
                />
              </div>

              <!-- Advantage Histogram -->
              <div class="chart-panel advantage-chart">
                <app-advantage-histogram
                  [data]="advantageData()"
                />
              </div>

              <!-- Agent-Task Heatmap -->
              <div class="chart-panel heatmap">
                <app-agent-task-heatmap
                  [data]="agentTaskData()"
                />
              </div>

              <!-- Quick Insights -->
              <div class="chart-panel quick-insights">
                <app-learning-insights-feed
                  [insights]="insights() | slice:0:5"
                  (applyInsight)="applyInsight($event)"
                  (dismissInsight)="dismissInsight($event)"
                />
              </div>
            </div>
          }

          @case ('strategies') {
            <div class="strategies-layout">
              <app-strategy-comparison
                [strategies]="strategies()"
              />
            </div>
          }

          @case ('patterns') {
            <div class="patterns-layout">
              <app-pattern-analytics
                [patterns]="patterns()"
              />
            </div>
          }

          @case ('insights') {
            <div class="insights-layout">
              <app-learning-insights-feed
                [insights]="insights()"
                (applyInsight)="applyInsight($event)"
                (dismissInsight)="dismissInsight($event)"
              />
            </div>
          }

          @case ('config') {
            <div class="config-layout">
              <app-grpo-config-panel
                [config]="config()"
                (configChange)="onConfigChange($event)"
              />
            </div>
          }
        }
      </div>

      <!-- Status Bar -->
      <div class="status-bar">
        <span class="status-item">
          Last updated: {{ formatTime(stats()?.lastUpdated || 0) }}
        </span>
        @if (autoRefresh()) {
          <span class="status-item">
            Auto-refresh: {{ refreshInterval() / 1000 }}s
          </span>
        }
        <span class="status-item">
          {{ rewardData().length }} data points
        </span>
      </div>
    </div>
  `,
  styles: [`
    .dashboard-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-primary);
      overflow: hidden;
    }

    .dashboard-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-md);
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .dashboard-icon {
      font-size: 24px;
    }

    .dashboard-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }

    .training-badge {
      padding: 4px 8px;
      border-radius: 12px;
      font-size: 10px;
      font-weight: 600;
      background: var(--bg-tertiary);
      color: var(--text-muted);

      &.active {
        background: rgba(16, 185, 129, 0.2);
        color: #10b981;
        animation: pulse 2s infinite;
      }
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    .header-actions {
      display: flex;
      gap: var(--spacing-sm);
      align-items: center;
    }

    .action-btn {
      padding: 6px 12px;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
        border-color: var(--primary-color);
      }
    }

    .export-dropdown {
      position: relative;
    }

    .export-menu {
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 4px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      overflow: hidden;
      z-index: 100;

      button {
        display: block;
        width: 100%;
        padding: 8px 16px;
        border: none;
        background: transparent;
        color: var(--text-primary);
        font-size: 12px;
        text-align: left;
        cursor: pointer;

        &:hover {
          background: var(--bg-hover);
        }
      }
    }

    .tab-navigation {
      display: flex;
      gap: 4px;
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
    }

    .tab-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border: none;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-muted);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.active {
        background: var(--primary-color);
        color: white;
      }
    }

    .tab-icon {
      font-size: 14px;
    }

    .stats-overview {
      display: flex;
      gap: var(--spacing-md);
      padding: var(--spacing-md);
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      overflow-x: auto;
    }

    .stat-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 100px;
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);

      &.highlight {
        background: rgba(99, 102, 241, 0.1);
        border: 1px solid var(--primary-color);
      }
    }

    .stat-value {
      font-size: 18px;
      font-weight: 700;
      font-family: var(--font-mono);
      color: var(--text-primary);
    }

    .stat-label {
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .tab-content {
      flex: 1;
      overflow: auto;
      padding: var(--spacing-md);
    }

    .overview-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-rows: 1fr 1fr;
      gap: var(--spacing-md);
      height: 100%;
    }

    .chart-panel {
      background: var(--bg-secondary);
      border-radius: var(--radius-md);
      overflow: hidden;
    }

    .reward-chart {
      grid-column: 1 / 2;
      grid-row: 1 / 2;
    }

    .advantage-chart {
      grid-column: 2 / 3;
      grid-row: 1 / 2;
    }

    .heatmap {
      grid-column: 1 / 2;
      grid-row: 2 / 3;
    }

    .quick-insights {
      grid-column: 2 / 3;
      grid-row: 2 / 3;
    }

    .strategies-layout,
    .patterns-layout,
    .insights-layout,
    .config-layout {
      height: 100%;
    }

    .status-bar {
      display: flex;
      gap: var(--spacing-lg);
      padding: var(--spacing-xs) var(--spacing-md);
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
    }

    .status-item {
      font-size: 10px;
      color: var(--text-muted);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnhancedGrpoDashboardComponent implements OnInit, OnDestroy {
  private ipc = inject(ElectronIpcService);
  private exportService = inject(TrainingExportService);
  private destroy$ = new Subject<void>();

  // Tab configuration
  tabs = [
    { id: 'overview' as const, label: 'Overview', icon: '📊' },
    { id: 'strategies' as const, label: 'Strategies', icon: '🎯' },
    { id: 'patterns' as const, label: 'Patterns', icon: '🔍' },
    { id: 'insights' as const, label: 'Insights', icon: '💡' },
    { id: 'config' as const, label: 'Config', icon: '⚙️' },
  ];

  // State
  activeTab = signal<DashboardTab>('overview');
  isTrainingActive = signal<boolean>(false);
  autoRefresh = signal<boolean>(true);
  refreshInterval = signal<number>(5000);
  showExportMenu = signal<boolean>(false);

  // Data signals
  stats = signal<DashboardStats | null>(null);
  rewardData = signal<RewardDataPoint[]>([]);
  advantageData = signal<AdvantageDataPoint[]>([]);
  strategies = signal<StrategyPerformance[]>([]);
  agentTaskData = signal<AgentTaskMetric[]>([]);
  patterns = signal<PatternData[]>([]);
  patternDistribution = signal<PatternTypeDistribution[]>([]);
  insights = signal<LearningInsight[]>([]);
  config = signal<GRPOConfig>({
    groupSize: 8,
    learningRate: 0.001,
    clipEpsilon: 0.2,
    entropyCoef: 0.01,
    valueCoef: 0.5,
    minSamplesForTraining: 32,
  });

  ngOnInit(): void {
    this.refreshData();

    // Set up auto-refresh
    interval(this.refreshInterval())
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        if (this.autoRefresh()) {
          this.refreshData();
        }
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  setActiveTab(tab: DashboardTab): void {
    this.activeTab.set(tab);
  }

  toggleAutoRefresh(): void {
    this.autoRefresh.update(v => !v);
  }

  toggleExportMenu(): void {
    this.showExportMenu.update(v => !v);
  }

  async refreshData(): Promise<void> {
    try {
      // Fetch all data in parallel
      const [statsResult, rewardResult, advantageResult, strategiesResult, agentResult, patternsResult, insightsResult] = await Promise.all([
        this.ipc.invoke('training:get-stats'),
        this.ipc.invoke('training:get-reward-data', { limit: 500 }),
        this.ipc.invoke('training:get-advantage-data'),
        this.ipc.invoke('training:get-strategies'),
        this.ipc.invoke('training:get-agent-performance'),
        this.ipc.invoke('training:get-patterns', { limit: 20 }),
        this.ipc.invoke('training:get-insights'),
      ]);

      if (statsResult.success && statsResult.data) {
        const data = statsResult.data as DashboardStats;
        this.stats.set(data);
        this.isTrainingActive.set(data.totalEpisodes > 0);
      }

      if (rewardResult.success && rewardResult.data) {
        this.rewardData.set(rewardResult.data as RewardDataPoint[]);
      }

      if (advantageResult.success && advantageResult.data) {
        this.advantageData.set(advantageResult.data as AdvantageDataPoint[]);
      }

      if (strategiesResult.success && strategiesResult.data) {
        this.strategies.set(strategiesResult.data as StrategyPerformance[]);
      }

      if (agentResult.success && agentResult.data) {
        this.agentTaskData.set(agentResult.data as AgentTaskMetric[]);
      }

      if (patternsResult.success && patternsResult.data) {
        const patterns = patternsResult.data as PatternData[];
        this.patterns.set(patterns);
        this.updatePatternDistribution(patterns);
      }

      if (insightsResult.success && insightsResult.data) {
        this.insights.set(insightsResult.data as LearningInsight[]);
      }
    } catch (error) {
      console.error('Failed to refresh training data:', error);
    }
  }

  private updatePatternDistribution(patterns: PatternData[]): void {
    const typeCount = new Map<string, number>();

    for (const pattern of patterns) {
      typeCount.set(pattern.type, (typeCount.get(pattern.type) || 0) + 1);
    }

    this.patternDistribution.set(
      Array.from(typeCount.entries()).map(([type, count]) => ({
        type,
        count,
        percentage: (count / patterns.length) * 100,
      }))
    );
  }

  async applyInsight(insight: LearningInsight): Promise<void> {
    try {
      await this.ipc.invoke('training:apply-insight', { insightId: insight.id });
      this.refreshData();
    } catch (error) {
      console.error('Failed to apply insight:', error);
    }
  }

  async dismissInsight(insight: LearningInsight): Promise<void> {
    try {
      await this.ipc.invoke('training:dismiss-insight', { insightId: insight.id });
      // Remove from local state immediately for better UX
      this.insights.update(list => list.filter(i => i.id !== insight.id));
    } catch (error) {
      console.error('Failed to dismiss insight:', error);
    }
  }

  async onConfigChange(newConfig: GRPOConfig): Promise<void> {
    try {
      await this.ipc.invoke('training:update-config', { config: newConfig });
      this.config.set(newConfig);
    } catch (error) {
      console.error('Failed to update config:', error);
    }
  }

  onStrategySelect(strategyId: string): void {
    console.log('Strategy selected:', strategyId);
  }

  onPatternClick(patternId: string): void {
    console.log('Pattern clicked:', patternId);
  }

  exportData(format: 'json' | 'csv' | 'pdf'): void {
    this.showExportMenu.set(false);

    const data = {
      stats: this.stats(),
      rewardData: this.rewardData(),
      strategies: this.strategies(),
      patterns: this.patterns(),
      insights: this.insights(),
      config: this.config() as unknown as Record<string, number | boolean | string>,
    };

    switch (format) {
      case 'json':
        this.exportService.exportAsJSON(data);
        break;
      case 'csv':
        this.exportService.exportAsCSV(data);
        break;
      case 'pdf':
        this.exportService.exportAsPDF(data);
        break;
    }
  }

  formatNumber(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }

  formatTime(timestamp: number): string {
    if (!timestamp) return 'Never';
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(timestamp).toLocaleTimeString();
  }
}
