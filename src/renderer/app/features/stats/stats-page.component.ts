/**
 * Stats Page
 * Usage analytics, tool metrics, and session summaries.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { StatsIpcService } from '../../core/services/ipc/stats-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { EchartsThemedComponent } from '../../shared/components/echarts-themed/echarts-themed.component';
import type { EChartsOption } from 'echarts';

// ─── Local Interfaces ──────────────────────────────────────────────────────────

interface StatsData {
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  sessions: SessionStat[];
  toolUsage: Record<string, number>;
  messagesPerSession: number[];
}

interface SessionStat {
  sessionId: string;
  agentId: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  duration: number;
  startedAt: number;
}

type Period = 'day' | 'week' | 'month' | 'year' | 'all';

const PERIOD_LABELS: Record<Period, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  year: 'Year',
  all: 'All',
};

const PERIODS: Period[] = ['day', 'week', 'month', 'year', 'all'];

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-stats-page',
  standalone: true,
  imports: [CommonModule, EchartsThemedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">

      <!-- Page header -->
      <div class="page-header">
        <div class="header-title">
          <span class="title">Statistics & Metrics</span>
          <span class="subtitle">Usage analytics, tool metrics, and session summaries</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="loading()" (click)="loadStats(currentPeriod())">
            Refresh
          </button>
          <button class="btn" type="button" [disabled]="loading() || exporting()" (click)="exportStats()">
            {{ exporting() ? 'Exporting...' : 'Export' }}
          </button>
        </div>
      </div>

      <!-- Error / info banners -->
      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }
      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <!-- Period selector -->
      <div class="period-selector">
        @for (period of periods; track period) {
          <button
            class="period-btn"
            type="button"
            [class.active]="currentPeriod() === period"
            (click)="loadStats(period)"
          >
            {{ periodLabel(period) }}
          </button>
        }
      </div>

      <!-- Main content area + sidebar -->
      <div class="content">
        <div class="main-area">

          <!-- Metric cards -->
          <div class="metric-cards">
            <div class="metric-card">
              <div class="metric-label">Total Sessions</div>
              <div class="metric-value">{{ stats()?.totalSessions ?? '—' }}</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Total Messages</div>
              <div class="metric-value">{{ stats()?.totalMessages ?? '—' }}</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Total Tokens</div>
              <div class="metric-value">{{ formatNumber(stats()?.totalTokens) }}</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Total Cost</div>
              <div class="metric-value">{{ formatCost(stats()?.totalCost) }}</div>
            </div>
          </div>

          <!-- Charts row -->
          <div class="charts-row">
            <div class="chart-card">
              <div class="chart-title">Messages per Session</div>
              <app-echarts-themed
                [options]="barChartOption()"
                [loading]="loading()"
                height="260px"
                emptyMessage="No session data for this period"
              />
            </div>
            <div class="chart-card">
              <div class="chart-title">Tool Usage</div>
              <app-echarts-themed
                [options]="pieChartOption()"
                [loading]="loading()"
                height="260px"
                emptyMessage="No tool usage data for this period"
              />
            </div>
          </div>

          <!-- Session table -->
          <div class="table-card">
            <div class="table-title">Session Details</div>
            @if ((stats()?.sessions ?? []).length > 0) {
              <div class="table-scroll">
                <table class="session-table">
                  <thead>
                    <tr>
                      <th>Session ID</th>
                      <th>Agent</th>
                      <th>Messages</th>
                      <th>Tokens</th>
                      <th>Cost</th>
                      <th>Duration</th>
                      <th>Started At</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (session of stats()!.sessions; track session.sessionId) {
                      <tr>
                        <td class="mono truncate" [title]="session.sessionId">{{ session.sessionId }}</td>
                        <td class="mono truncate" [title]="session.agentId">{{ session.agentId }}</td>
                        <td class="num">{{ session.messages }}</td>
                        <td class="num">{{ formatNumber(session.inputTokens + session.outputTokens) }}</td>
                        <td class="num">{{ formatCost(session.cost) }}</td>
                        <td class="num">{{ formatDuration(session.duration) }}</td>
                        <td class="dim">{{ formatDate(session.startedAt) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            } @else {
              <div class="empty-table">No sessions recorded for this period.</div>
            }
          </div>

        </div><!-- /.main-area -->

        <!-- Right sidebar: storage stats -->
        <div class="sidebar">
          <div class="panel-card">
            <div class="panel-title">Storage</div>
            @if (storageStats()) {
              <div class="storage-list">
                <div class="storage-row">
                  <span class="storage-label">DB Size</span>
                  <span class="storage-value">{{ formatBytes(storageStats()!.dbSize) }}</span>
                </div>
                <div class="storage-row">
                  <span class="storage-label">Log Files</span>
                  <span class="storage-value">{{ formatBytes(storageStats()!.logSize) }}</span>
                </div>
                <div class="storage-row">
                  <span class="storage-label">Snapshots</span>
                  <span class="storage-value">{{ formatBytes(storageStats()!.snapshotSize) }}</span>
                </div>
                <div class="storage-divider"></div>
                <div class="storage-row total">
                  <span class="storage-label">Total</span>
                  <span class="storage-value">
                    {{ formatBytes(storageStats()!.dbSize + storageStats()!.logSize + storageStats()!.snapshotSize) }}
                  </span>
                </div>
              </div>
            } @else {
              <div class="hint">Storage info not available.</div>
            }
          </div>

          <div class="panel-card">
            <div class="panel-title">Summary</div>
            <div class="summary-list">
              <div class="summary-row">
                <span class="summary-label">Period</span>
                <span class="summary-value">{{ periodLabel(currentPeriod()) }}</span>
              </div>
              <div class="summary-row">
                <span class="summary-label">Avg Msgs / Session</span>
                <span class="summary-value">{{ avgMessagesPerSession() }}</span>
              </div>
              <div class="summary-row">
                <span class="summary-label">Unique Tools</span>
                <span class="summary-value">{{ uniqueToolCount() }}</span>
              </div>
              <div class="summary-row">
                <span class="summary-label">Top Tool</span>
                <span class="summary-value">{{ topTool() }}</span>
              </div>
            </div>
          </div>
        </div><!-- /.sidebar -->

      </div><!-- /.content -->
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      width: 100%;
      height: 100%;
    }

    .page {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow: auto;
    }

    /* ── Header ──────────────────────────────────────── */

    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      flex-shrink: 0;
    }

    .header-title {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
    }

    .title {
      font-size: 18px;
      font-weight: 700;
    }

    .subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }

    .header-actions {
      display: flex;
      gap: var(--spacing-xs);
    }

    .btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    /* ── Banners ─────────────────────────────────────── */

    .error-banner,
    .info-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      font-size: 12px;
      flex-shrink: 0;
    }

    .error-banner {
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
    }

    .info-banner {
      border: 1px solid color-mix(in srgb, var(--primary-color) 60%, transparent);
      background: color-mix(in srgb, var(--primary-color) 12%, transparent);
      color: var(--text-primary);
    }

    /* ── Period selector ─────────────────────────────── */

    .period-selector {
      display: flex;
      gap: var(--spacing-xs);
      flex-shrink: 0;
    }

    .period-btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }

    .period-btn:hover {
      background: var(--bg-secondary);
      color: var(--text-primary);
    }

    .period-btn.active {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #000;
      font-weight: 600;
    }

    /* ── Content grid ────────────────────────────────── */

    .content {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 260px;
      gap: var(--spacing-md);
      align-items: start;
    }

    .main-area {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      min-width: 0;
    }

    /* ── Metric cards ────────────────────────────────── */

    .metric-cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--spacing-sm);
    }

    .metric-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .metric-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
    }

    .metric-value {
      font-size: 22px;
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1.2;
    }

    /* ── Charts ──────────────────────────────────────── */

    .charts-row {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--spacing-md);
    }

    .chart-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .chart-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
    }

    /* ── Table ───────────────────────────────────────── */

    .table-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .table-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
    }

    .table-scroll {
      overflow-x: auto;
    }

    .session-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .session-table th {
      text-align: left;
      padding: var(--spacing-xs) var(--spacing-sm);
      border-bottom: 1px solid var(--border-color);
      color: var(--text-muted);
      font-weight: 600;
      white-space: nowrap;
    }

    .session-table td {
      padding: var(--spacing-xs) var(--spacing-sm);
      border-bottom: 1px solid color-mix(in srgb, var(--border-color) 50%, transparent);
      color: var(--text-secondary);
      vertical-align: middle;
    }

    .session-table tr:last-child td {
      border-bottom: none;
    }

    .session-table tr:hover td {
      background: color-mix(in srgb, var(--bg-tertiary) 60%, transparent);
    }

    .session-table td.mono {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
    }

    .session-table td.truncate {
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-table td.num {
      text-align: right;
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
    }

    .session-table td.dim {
      color: var(--text-muted);
      white-space: nowrap;
    }

    .empty-table {
      font-size: 12px;
      color: var(--text-muted);
      padding: var(--spacing-sm) 0;
    }

    /* ── Sidebar ─────────────────────────────────────── */

    .sidebar {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .panel-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .panel-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
    }

    .storage-list,
    .summary-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .storage-row,
    .summary-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      gap: var(--spacing-xs);
    }

    .storage-label,
    .summary-label {
      color: var(--text-muted);
    }

    .storage-value,
    .summary-value {
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
      font-weight: 500;
    }

    .storage-divider {
      border-top: 1px solid var(--border-color);
      margin: var(--spacing-xs) 0;
    }

    .storage-row.total .storage-label,
    .storage-row.total .storage-value {
      font-weight: 700;
      color: var(--text-primary);
    }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
    }

    /* ── Responsive ──────────────────────────────────── */

    @media (max-width: 1100px) {
      .content {
        grid-template-columns: 1fr;
      }

      .metric-cards {
        grid-template-columns: repeat(2, 1fr);
      }

      .charts-row {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 640px) {
      .metric-cards {
        grid-template-columns: 1fr;
      }
    }
  `],
})
export class StatsPageComponent implements OnInit {
  private readonly statsIpc = inject(StatsIpcService);

  // ── State ────────────────────────────────────────────────────────────────────

  readonly currentPeriod = signal<Period>('week');
  readonly loading = signal(false);
  readonly exporting = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);
  readonly stats = signal<StatsData | null>(null);

  // ── Constants ────────────────────────────────────────────────────────────────

  readonly periods = PERIODS;

  // ── Derived: sidebar summary ──────────────────────────────────────────────────

  readonly avgMessagesPerSession = computed(() => {
    const data = this.stats();
    if (!data || data.totalSessions === 0) return '—';
    return (data.totalMessages / data.totalSessions).toFixed(1);
  });

  readonly uniqueToolCount = computed(() => {
    const data = this.stats();
    if (!data) return '—';
    return String(Object.keys(data.toolUsage).length);
  });

  readonly topTool = computed(() => {
    const data = this.stats();
    if (!data) return '—';
    const entries = Object.entries(data.toolUsage);
    if (entries.length === 0) return '—';
    const top = entries.reduce((best, curr) => (curr[1] > best[1] ? curr : best));
    return top[0];
  });

  readonly storageStats = computed(() => {
    const data = this.stats();
    if (!data) return null;
    const raw = data as unknown as Record<string, unknown>;
    if (
      typeof raw['dbSize'] !== 'number' &&
      typeof raw['logSize'] !== 'number' &&
      typeof raw['snapshotSize'] !== 'number'
    ) {
      return null;
    }
    return {
      dbSize: (raw['dbSize'] as number) ?? 0,
      logSize: (raw['logSize'] as number) ?? 0,
      snapshotSize: (raw['snapshotSize'] as number) ?? 0,
    };
  });

  // ── Derived: chart options ────────────────────────────────────────────────────

  readonly barChartOption = computed((): EChartsOption | null => {
    const data = this.stats();
    if (!data || data.messagesPerSession.length === 0) return null;

    const messageCounts = data.messagesPerSession;
    const sessionLabels = messageCounts.map((_, i) => `S${i + 1}`);

    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: sessionLabels },
      yAxis: { type: 'value' },
      series: [
        {
          type: 'bar',
          data: messageCounts,
          itemStyle: { borderRadius: [4, 4, 0, 0] },
        },
      ],
    };
  });

  readonly pieChartOption = computed((): EChartsOption | null => {
    const data = this.stats();
    if (!data) return null;
    const toolData = Object.entries(data.toolUsage);
    if (toolData.length === 0) return null;

    return {
      tooltip: { trigger: 'item' },
      series: [
        {
          type: 'pie',
          radius: ['35%', '65%'],
          data: toolData.map(([name, value]) => ({ name, value })),
        },
      ],
    };
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    await this.loadStats('week');
  }

  // ── Actions ───────────────────────────────────────────────────────────────────

  async loadStats(period: Period): Promise<void> {
    this.currentPeriod.set(period);
    this.loading.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      const response: IpcResponse = await this.statsIpc.statsGetStats(period);
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to load stats.');
        return;
      }
      this.stats.set(this.normalizeStatsData(response.data));
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async exportStats(): Promise<void> {
    this.exporting.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      const response: IpcResponse = await this.statsIpc.statsExport(
        '/tmp/stats-export.json',
        this.currentPeriod()
      );
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Export failed.');
        return;
      }
      this.infoMessage.set('Stats exported to /tmp/stats-export.json');
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.exporting.set(false);
    }
  }

  // ── Formatting helpers ────────────────────────────────────────────────────────

  periodLabel(period: Period): string {
    return PERIOD_LABELS[period];
  }

  formatNumber(value: number | undefined): string {
    if (value == null) return '—';
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return String(value);
  }

  formatCost(value: number | undefined): string {
    if (value == null) return '—';
    return `$${value.toFixed(4)}`;
  }

  formatDuration(ms: number): string {
    if (ms < 1_000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1_000);
    return `${minutes}m ${seconds}s`;
  }

  formatDate(timestamp: number): string {
    if (!timestamp) return '—';
    return new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  formatBytes(bytes: number | undefined): string {
    if (bytes == null || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private normalizeStatsData(raw: unknown): StatsData {
    if (raw !== null && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      return {
        totalSessions: Number(obj['totalSessions'] ?? 0),
        totalMessages: Number(obj['totalMessages'] ?? 0),
        totalTokens: Number(obj['totalTokens'] ?? 0),
        totalCost: Number(obj['totalCost'] ?? 0),
        sessions: Array.isArray(obj['sessions'])
          ? (obj['sessions'] as unknown[]).map(this.normalizeSession)
          : [],
        toolUsage:
          obj['toolUsage'] !== null && typeof obj['toolUsage'] === 'object'
            ? (obj['toolUsage'] as Record<string, number>)
            : {},
        messagesPerSession: Array.isArray(obj['messagesPerSession'])
          ? (obj['messagesPerSession'] as number[])
          : [],
      };
    }
    return {
      totalSessions: 0,
      totalMessages: 0,
      totalTokens: 0,
      totalCost: 0,
      sessions: [],
      toolUsage: {},
      messagesPerSession: [],
    };
  }

  private readonly normalizeSession = (raw: unknown): SessionStat => {
    const obj = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      sessionId: String(obj['sessionId'] ?? ''),
      agentId: String(obj['agentId'] ?? ''),
      messages: Number(obj['messages'] ?? 0),
      inputTokens: Number(obj['inputTokens'] ?? 0),
      outputTokens: Number(obj['outputTokens'] ?? 0),
      cost: Number(obj['cost'] ?? 0),
      duration: Number(obj['duration'] ?? 0),
      startedAt: Number(obj['startedAt'] ?? 0),
    };
  };
}
