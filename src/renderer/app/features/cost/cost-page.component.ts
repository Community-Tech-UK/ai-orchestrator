/**
 * Cost Tracking Page — E15 Usage/Cost Analytics
 *
 * Presents:
 *   - Aggregate metric cards (total cost, tokens, requests, avg cost/session)
 *   - Budget usage (daily / weekly / monthly)
 *   - Cost-over-time line chart + cost-by-model donut chart
 *   - Per-model breakdown table (model, cost, input tokens, output tokens, requests)
 *   - Per-session rows table (sessionId, cost, tokens, requests)
 *   - Recent entries table
 *   - Budget configuration form
 *
 * Data sources (all via existing IPC handlers):
 *   COST_GET_SUMMARY → CostSummary (byModel, bySession, totalCost, totalInputTokens …)
 *   COST_GET_ENTRIES → CostEntry[] (instanceId, sessionId, model, tokens, cost)
 *   COST_GET_BUDGET_STATUS → { daily, weekly, monthly } usage/limit/pct
 *   COST_SET_BUDGET → save limits
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { CostIpcService } from '../../core/services/ipc/cost-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { EchartsThemedComponent } from '../../shared/components/echarts-themed/echarts-themed.component';
import type { EChartsOption } from 'echarts';

// ─── Local data shapes ────────────────────────────────────────────────────────

/** Shape returned by COST_GET_SUMMARY */
export interface CostSummaryData {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  byModel: Record<string, {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    requests: number;
  }>;
  bySession: Record<string, {
    cost: number;
    tokens: number;
    requests: number;
  }>;
  requestCount: number;
  startTime: number;
  endTime: number;
}

/** Single cost entry returned by COST_GET_ENTRIES */
export interface CostEntry {
  id: string;
  timestamp: number;
  instanceId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost: number;
}

/** Flattened row for the per-model breakdown table */
export interface ModelRow {
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costPct: number;
}

/** Flattened row for the per-session breakdown table */
export interface SessionRow {
  sessionId: string;
  cost: number;
  tokens: number;
  requests: number;
  costPct: number;
}

/** Shape returned by COST_GET_BUDGET_STATUS */
interface BudgetStatusData {
  daily: { usage: number; limit: number; percentage: number };
  weekly: { usage: number; limit: number; percentage: number };
  monthly: { usage: number; limit: number; percentage: number };
}

const EMPTY_SUMMARY: CostSummaryData = {
  totalCost: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  byModel: {},
  bySession: {},
  requestCount: 0,
  startTime: 0,
  endTime: 0,
};

const EMPTY_BUDGET_STATUS: BudgetStatusData = {
  daily: { usage: 0, limit: 0, percentage: 0 },
  weekly: { usage: 0, limit: 0, percentage: 0 },
  monthly: { usage: 0, limit: 0, percentage: 0 },
};

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-cost-page',
  standalone: true,
  imports: [CommonModule, EchartsThemedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <!-- Page header -->
      <div class="page-header">
        <button class="header-btn" type="button" (click)="goBack()">← Back</button>
        <div class="header-title">
          <span class="title">Usage & Cost Analytics</span>
          <span class="subtitle">Token usage, costs, and budget management</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="working()" (click)="refreshAll(true)">
            Refresh
          </button>
        </div>
      </div>

      <!-- Error banner -->
      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      <!-- Info banner -->
      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <!-- Budget alert banner -->
      @if (budgetAlert()) {
        <div class="alert-banner">{{ budgetAlert() }}</div>
      }

      <!-- Metric cards row 1: cost & session aggregates -->
      <div class="metrics-row">
        <div class="metric-card">
          <div class="metric-value">\${{ totalCost().toFixed(4) }}</div>
          <div class="metric-label">Total Spend</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">{{ requestCount() }}</div>
          <div class="metric-label">API Requests</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">{{ sessionCount() }}</div>
          <div class="metric-label">Sessions</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">\${{ avgCostPerSession().toFixed(4) }}</div>
          <div class="metric-label">Avg Cost / Session</div>
        </div>
      </div>

      <!-- Metric cards row 2: token totals -->
      <div class="metrics-row">
        <div class="metric-card">
          <div class="metric-value">{{ formatTokens(totalInputTokens()) }}</div>
          <div class="metric-label">Input Tokens</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">{{ formatTokens(totalOutputTokens()) }}</div>
          <div class="metric-label">Output Tokens</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">{{ formatTokens(totalCacheTokens()) }}</div>
          <div class="metric-label">Cache Tokens</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">{{ formatTokens(totalTokens()) }}</div>
          <div class="metric-label">Total Tokens</div>
        </div>
      </div>

      <!-- Budget status row -->
      <div class="metrics-row">
        <div class="metric-card" [class.over-budget]="budgetStatus().daily.percentage >= 100">
          <div class="metric-value">{{ budgetStatus().daily.percentage.toFixed(1) }}%</div>
          <div class="metric-label">Daily Budget Used</div>
          <div class="metric-sub">\${{ budgetStatus().daily.usage.toFixed(4) }} / \${{ budgetStatus().daily.limit.toFixed(2) }}</div>
        </div>
        <div class="metric-card" [class.over-budget]="budgetStatus().weekly.percentage >= 100">
          <div class="metric-value">{{ budgetStatus().weekly.percentage.toFixed(1) }}%</div>
          <div class="metric-label">Weekly Budget Used</div>
          <div class="metric-sub">\${{ budgetStatus().weekly.usage.toFixed(4) }} / \${{ budgetStatus().weekly.limit.toFixed(2) }}</div>
        </div>
        <div class="metric-card" [class.over-budget]="budgetStatus().monthly.percentage >= 100">
          <div class="metric-value">{{ budgetStatus().monthly.percentage.toFixed(1) }}%</div>
          <div class="metric-label">Monthly Budget Used</div>
          <div class="metric-sub">\${{ budgetStatus().monthly.usage.toFixed(4) }} / \${{ budgetStatus().monthly.limit.toFixed(2) }}</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">{{ modelCount() }}</div>
          <div class="metric-label">Models Used</div>
        </div>
      </div>

      <!-- Charts row -->
      <div class="charts-row">
        <!-- Cost over time -->
        <div class="chart-card">
          <div class="chart-title">Cost Over Time</div>
          <app-echarts-themed
            [options]="lineChartOptions()"
            [loading]="loading()"
            height="260px"
            emptyMessage="No cost history yet"
          />
        </div>

        <!-- Cost by model -->
        <div class="chart-card">
          <div class="chart-title">Cost by Model</div>
          <app-echarts-themed
            [options]="donutChartOptions()"
            [loading]="loading()"
            height="260px"
            emptyMessage="No model breakdown yet"
          />
        </div>
      </div>

      <!-- Per-model breakdown table -->
      <div class="panel-card">
        <div class="panel-title">Per-Model Breakdown</div>
        @if (modelRows().length > 0) {
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th class="num-col">Cost</th>
                  <th class="num-col">% of Total</th>
                  <th class="num-col">Input Tokens</th>
                  <th class="num-col">Output Tokens</th>
                  <th class="num-col">Requests</th>
                </tr>
              </thead>
              <tbody>
                @for (row of modelRows(); track row.model) {
                  <tr>
                    <td class="provider-cell">{{ row.model }}</td>
                    <td class="num-col mono">\${{ row.cost.toFixed(6) }}</td>
                    <td class="num-col">
                      <div class="bar-cell">
                        <div class="bar-fill" [style.width.%]="row.costPct"></div>
                        <span class="bar-label">{{ row.costPct.toFixed(1) }}%</span>
                      </div>
                    </td>
                    <td class="num-col mono">{{ row.inputTokens.toLocaleString() }}</td>
                    <td class="num-col mono">{{ row.outputTokens.toLocaleString() }}</td>
                    <td class="num-col mono">{{ row.requests.toLocaleString() }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="empty-hint">No model usage recorded yet.</div>
        }
      </div>

      <!-- Per-session breakdown table -->
      <div class="panel-card">
        <div class="panel-title">Per-Session Breakdown</div>
        @if (sessionRows().length > 0) {
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Session ID</th>
                  <th class="num-col">Cost</th>
                  <th class="num-col">% of Total</th>
                  <th class="num-col">Tokens</th>
                  <th class="num-col">Requests</th>
                </tr>
              </thead>
              <tbody>
                @for (row of sessionRows(); track row.sessionId) {
                  <tr>
                    <td class="mono truncate-cell">{{ row.sessionId }}</td>
                    <td class="num-col mono">\${{ row.cost.toFixed(6) }}</td>
                    <td class="num-col">
                      <div class="bar-cell">
                        <div class="bar-fill" [style.width.%]="row.costPct"></div>
                        <span class="bar-label">{{ row.costPct.toFixed(1) }}%</span>
                      </div>
                    </td>
                    <td class="num-col mono">{{ row.tokens.toLocaleString() }}</td>
                    <td class="num-col mono">{{ row.requests.toLocaleString() }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="empty-hint">No session data recorded yet.</div>
        }
      </div>

      <!-- Recent entries table -->
      <div class="panel-card">
        <div class="panel-title">Recent Entries</div>
        @if (entries().length > 0) {
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Model</th>
                  <th class="truncate-col">Instance ID</th>
                  <th class="truncate-col">Session ID</th>
                  <th class="num-col">Input Tokens</th>
                  <th class="num-col">Output Tokens</th>
                  <th class="num-col">Cost</th>
                </tr>
              </thead>
              <tbody>
                @for (entry of entries(); track entry.id) {
                  <tr>
                    <td class="mono">{{ formatTimestamp(entry.timestamp) }}</td>
                    <td>{{ entry.model }}</td>
                    <td class="mono truncate-cell" [title]="entry.instanceId">{{ entry.instanceId }}</td>
                    <td class="mono truncate-cell" [title]="entry.sessionId">{{ entry.sessionId }}</td>
                    <td class="num-col mono">{{ entry.inputTokens.toLocaleString() }}</td>
                    <td class="num-col mono">{{ entry.outputTokens.toLocaleString() }}</td>
                    <td class="num-col mono">\${{ entry.cost.toFixed(6) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="empty-hint">No usage recorded yet.</div>
        }
      </div>

      <!-- Budget config panel -->
      <div class="panel-card">
        <div class="panel-title">Budget Configuration</div>
        <div class="budget-grid">
          <label class="field">
            <span class="label">Daily Limit ($)</span>
            <input
              class="input"
              type="number"
              min="0"
              step="0.01"
              [value]="budgetDaily() ?? ''"
              (input)="onBudgetDailyInput($event)"
              placeholder="No limit"
            />
          </label>
          <label class="field">
            <span class="label">Weekly Limit ($)</span>
            <input
              class="input"
              type="number"
              min="0"
              step="0.01"
              [value]="budgetWeekly() ?? ''"
              (input)="onBudgetWeeklyInput($event)"
              placeholder="No limit"
            />
          </label>
          <label class="field">
            <span class="label">Monthly Limit ($)</span>
            <input
              class="input"
              type="number"
              min="0"
              step="0.01"
              [value]="budgetMonthly() ?? ''"
              (input)="onBudgetMonthlyInput($event)"
              placeholder="No limit"
            />
          </label>
          <label class="field">
            <span class="label">Per-Session Limit ($)</span>
            <input
              class="input"
              type="number"
              min="0"
              step="0.01"
              [value]="budgetPerSession() ?? ''"
              (input)="onBudgetPerSessionInput($event)"
              placeholder="No limit"
            />
          </label>
        </div>
        <div class="budget-actions">
          <button class="btn primary" type="button" [disabled]="working()" (click)="saveBudget()">
            Save Budget
          </button>
        </div>
      </div>
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
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    /* ── Header ─────────────────────────────────────── */
    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .header-title {
      display: flex;
      flex-direction: column;
      flex: 1;
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
      gap: var(--spacing-sm);
    }

    /* ── Buttons ────────────────────────────────────── */
    .header-btn,
    .btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
      transition: background var(--transition-fast);
    }

    .header-btn:hover,
    .btn:hover:not(:disabled) {
      background: var(--bg-secondary);
    }

    .btn.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #fff;
    }

    .btn.primary:hover:not(:disabled) {
      opacity: 0.9;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* ── Banners ────────────────────────────────────── */
    .error-banner,
    .info-banner,
    .alert-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      font-size: 12px;
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

    .alert-banner {
      border: 1px solid color-mix(in srgb, #f97316 60%, transparent);
      background: color-mix(in srgb, #f97316 12%, transparent);
      color: #f97316;
    }

    /* ── Metric cards ───────────────────────────────── */
    .metrics-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--spacing-md);
    }

    .metric-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      text-align: center;
    }

    .metric-card.over-budget {
      border-color: var(--error-color);
    }

    .metric-value {
      font-size: 28px;
      font-weight: 700;
      font-family: var(--font-family-mono);
      line-height: 1.2;
    }

    .metric-label {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: var(--spacing-xs);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .metric-sub {
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 2px;
      font-family: var(--font-family-mono);
    }

    /* ── Charts ─────────────────────────────────────── */
    .charts-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--spacing-md);
    }

    .chart-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
    }

    .chart-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: var(--spacing-sm);
    }

    /* ── Panel cards ────────────────────────────────── */
    .panel-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .panel-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    /* ── Tables ─────────────────────────────────────── */
    .table-wrapper {
      overflow-x: auto;
    }

    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .data-table th,
    .data-table td {
      padding: var(--spacing-xs) var(--spacing-sm);
      text-align: left;
      border-bottom: 1px solid var(--border-color);
    }

    .data-table th {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
    }

    .data-table tr:hover td {
      background: var(--bg-tertiary);
    }

    .num-col {
      text-align: right;
    }

    .provider-cell {
      font-weight: 500;
    }

    .truncate-col {
      max-width: 140px;
    }

    .truncate-cell {
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .mono {
      font-family: var(--font-family-mono);
    }

    /* ── Bar cells (cost percentage visualisation) ── */
    .bar-cell {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      justify-content: flex-end;
    }

    .bar-fill {
      height: 6px;
      min-width: 2px;
      max-width: 80px;
      background: var(--primary-color);
      border-radius: 3px;
      opacity: 0.7;
    }

    .bar-label {
      font-size: 11px;
      font-family: var(--font-family-mono);
      min-width: 38px;
      text-align: right;
    }

    .empty-hint {
      font-size: 12px;
      color: var(--text-muted);
      padding: var(--spacing-sm) 0;
    }

    /* ── Budget form ────────────────────────────────── */
    .budget-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--spacing-md);
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .label {
      font-size: 11px;
      color: var(--text-muted);
    }

    .input {
      width: 100%;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      font-family: var(--font-family-mono);
      transition: border-color var(--transition-fast);
    }

    .input:focus {
      outline: none;
      border-color: var(--primary-color);
    }

    .budget-actions {
      display: flex;
      justify-content: flex-end;
    }
  `],
})
export class CostPageComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly costIpc = inject(CostIpcService);

  // ── Raw state signals ────────────────────────────────────────────────────

  readonly loading = signal(false);
  readonly working = signal(false);
  readonly errorMessage = signal('');
  readonly infoMessage = signal('');
  readonly budgetAlert = signal('');

  readonly summary = signal<CostSummaryData>(EMPTY_SUMMARY);
  readonly entries = signal<CostEntry[]>([]);
  readonly budgetStatus = signal<BudgetStatusData>(EMPTY_BUDGET_STATUS);

  // Budget form fields
  readonly budgetDaily = signal<number | null>(null);
  readonly budgetWeekly = signal<number | null>(null);
  readonly budgetMonthly = signal<number | null>(null);
  readonly budgetPerSession = signal<number | null>(null);

  // ── Derived aggregate signals ────────────────────────────────────────────

  readonly totalCost = computed(() => this.summary().totalCost);
  readonly totalInputTokens = computed(() => this.summary().totalInputTokens);
  readonly totalOutputTokens = computed(() => this.summary().totalOutputTokens);
  readonly totalCacheTokens = computed(
    () => this.summary().totalCacheReadTokens + this.summary().totalCacheWriteTokens,
  );
  readonly totalTokens = computed(
    () => this.totalInputTokens() + this.totalOutputTokens() + this.totalCacheTokens(),
  );
  readonly requestCount = computed(() => this.summary().requestCount);
  readonly sessionCount = computed(() => Object.keys(this.summary().bySession).length);
  readonly modelCount = computed(() => Object.keys(this.summary().byModel).length);

  readonly avgCostPerSession = computed(() => {
    const count = this.sessionCount();
    return count > 0 ? this.totalCost() / count : 0;
  });

  // ── Per-model breakdown rows ─────────────────────────────────────────────

  readonly modelRows = computed((): ModelRow[] => {
    const byModel = this.summary().byModel;
    const total = this.totalCost();
    return Object.entries(byModel)
      .map(([model, stats]) => ({
        model,
        cost: stats.cost,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        requests: stats.requests,
        costPct: total > 0 ? (stats.cost / total) * 100 : 0,
      }))
      .sort((a, b) => b.cost - a.cost);
  });

  // ── Per-session breakdown rows ───────────────────────────────────────────

  readonly sessionRows = computed((): SessionRow[] => {
    const bySession = this.summary().bySession;
    const total = this.totalCost();
    return Object.entries(bySession)
      .map(([sessionId, stats]) => ({
        sessionId,
        cost: stats.cost,
        tokens: stats.tokens,
        requests: stats.requests,
        costPct: total > 0 ? (stats.cost / total) * 100 : 0,
      }))
      .sort((a, b) => b.cost - a.cost);
  });

  // ── Chart options ────────────────────────────────────────────────────────

  readonly lineChartOptions = computed((): EChartsOption | null => {
    const items = this.entries();
    if (items.length === 0) return null;

    const sorted = [...items].sort((a, b) => a.timestamp - b.timestamp);
    const timestamps = sorted.map(e => this.formatTimestamp(e.timestamp));
    const costs = sorted.map(e => e.cost);

    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: timestamps },
      yAxis: { type: 'value', axisLabel: { formatter: '${value}' } },
      series: [{
        type: 'line',
        data: costs,
        smooth: true,
        areaStyle: { opacity: 0.1 },
      }],
    };
  });

  readonly donutChartOptions = computed((): EChartsOption | null => {
    const rows = this.modelRows();
    if (rows.length === 0) return null;

    return {
      tooltip: { trigger: 'item' },
      series: [{
        type: 'pie',
        radius: ['40%', '70%'],
        data: rows.map(r => ({ name: r.model, value: r.cost })),
      }],
    };
  });

  // ── Lifecycle & event subscriptions ─────────────────────────────────────

  private readonly unsubscribers: (() => void)[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.unsubscribers.push(
      this.costIpc.onCostUsageRecorded(() => {
        void this.refreshAll(false);
      }),
      this.costIpc.onCostBudgetWarning((data) => {
        const msg = (data as { message?: string })?.message ?? 'Budget warning threshold reached';
        this.budgetAlert.set(`Warning: ${msg}`);
      }),
      this.costIpc.onCostBudgetExceeded((data) => {
        const msg = (data as { message?: string })?.message ?? 'Budget limit exceeded';
        this.budgetAlert.set(`Budget exceeded: ${msg}`);
      }),
    );
  }

  ngOnInit(): void {
    void this.refreshAll(true);
    this.pollTimer = setInterval(() => void this.refreshAll(false), 10_000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
    }
    for (const unsub of this.unsubscribers) {
      unsub();
    }
  }

  // ── Data loading ─────────────────────────────────────────────────────────

  async refreshAll(showLoading = true): Promise<void> {
    if (showLoading) this.loading.set(true);
    this.errorMessage.set('');

    try {
      const [summaryResp, entriesResp, budgetResp] = await Promise.all([
        this.costIpc.costGetSummary(),
        this.costIpc.costGetEntries(100),
        this.costIpc.costGetBudgetStatus(),
      ]);

      this.summary.set(this.unwrapData<CostSummaryData>(summaryResp, EMPTY_SUMMARY));
      this.entries.set(this.unwrapData<CostEntry[]>(entriesResp, []));

      const budget = this.unwrapData<BudgetStatusData>(budgetResp, EMPTY_BUDGET_STATUS);
      this.budgetStatus.set(budget);

      // Populate form fields from the status limits
      this.budgetDaily.set(budget.daily.limit > 0 ? budget.daily.limit : null);
      this.budgetWeekly.set(budget.weekly.limit > 0 ? budget.weekly.limit : null);
      this.budgetMonthly.set(budget.monthly.limit > 0 ? budget.monthly.limit : null);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load cost data');
    } finally {
      if (showLoading) this.loading.set(false);
    }
  }

  // ── Budget form handlers ─────────────────────────────────────────────────

  onBudgetDailyInput(event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    this.budgetDaily.set(isNaN(val) ? null : val);
  }

  onBudgetWeeklyInput(event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    this.budgetWeekly.set(isNaN(val) ? null : val);
  }

  onBudgetMonthlyInput(event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    this.budgetMonthly.set(isNaN(val) ? null : val);
  }

  onBudgetPerSessionInput(event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    this.budgetPerSession.set(isNaN(val) ? null : val);
  }

  async saveBudget(): Promise<void> {
    this.working.set(true);
    this.infoMessage.set('');
    this.errorMessage.set('');
    try {
      const resp = await this.costIpc.costSetBudget({
        daily: this.budgetDaily() ?? undefined,
        weekly: this.budgetWeekly() ?? undefined,
        monthly: this.budgetMonthly() ?? undefined,
      });
      if (!resp.success) {
        this.errorMessage.set(resp.error?.message ?? 'Failed to save budget');
        return;
      }
      this.infoMessage.set('Budget saved');
      await this.refreshAll(false);
    } finally {
      this.working.set(false);
    }
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  goBack(): void {
    void this.router.navigate(['/']);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private unwrapData<T>(response: IpcResponse, fallback: T): T {
    return response.success ? ((response.data as T) ?? fallback) : fallback;
  }

  formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  }
}
