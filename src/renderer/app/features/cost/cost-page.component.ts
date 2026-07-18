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
import { CostIpcService } from '../../core/services/ipc/cost-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { EchartsThemedComponent } from '../../shared/components/echarts-themed/echarts-themed.component';
import type { EChartsOption } from 'echarts';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';

// ─── Local data shapes ────────────────────────────────────────────────────────

/** Shape returned by COST_GET_SUMMARY */
export interface CostSummaryData {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  byModel: Record<string, {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
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
  reasoningTokens?: number;
  cost: number;
}

/** Flattened row for the per-model breakdown table */
export interface ModelRow {
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
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
  totalReasoningTokens: 0,
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
  templateUrl: './cost-page.component.html',
  styleUrl: './cost-page.component.scss',
})
export class CostPageComponent implements OnInit, OnDestroy {
  private readonly costIpc = inject(CostIpcService);
  private readonly pollScheduler = inject(RendererPollSchedulerService);

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
  readonly totalInputTokens = computed(() => this.summary().totalInputTokens ?? 0);
  readonly totalOutputTokens = computed(() => this.summary().totalOutputTokens ?? 0);
  readonly totalCacheTokens = computed(
    () => (this.summary().totalCacheReadTokens ?? 0) + (this.summary().totalCacheWriteTokens ?? 0),
  );
  readonly totalReasoningTokens = computed(() => this.summary().totalReasoningTokens ?? 0);
  readonly totalTokens = computed(
    () => this.totalInputTokens() + this.totalOutputTokens() + this.totalCacheTokens() + this.totalReasoningTokens(),
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
        reasoningTokens: stats.reasoningTokens ?? 0,
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
  private stopPolling: (() => void) | null = null;

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
    this.stopPolling = this.pollScheduler.register(() => this.refreshAll(false), 10_000);
  }

  ngOnDestroy(): void {
    this.stopPolling?.();
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
