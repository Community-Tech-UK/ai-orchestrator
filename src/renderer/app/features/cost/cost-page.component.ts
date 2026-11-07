import { copyFor } from '../../shared/tooltip/tooltip-copy';
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
import type { CodexEphemeralUsageResult } from '../../../../shared/types/codex-ephemeral-usage.types';
import { InstanceStore } from '../../core/state/instance.store';
import { HistoryStore } from '../../core/state/history.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import { resolveBillingMode } from '../../../../shared/utils/billing-mode';
import { resolveCostSessionLabel } from './cost-session-label';
import type { SessionSpendBreakdown, SessionSpendModel } from '../../../../shared/types/cost-session.types';
import { Router } from '@angular/router';
import type { ProviderId } from '../../../../shared/types/provider-quota.types';
import { CommonModule } from '@angular/common';
import { CostIpcService } from '../../core/services/ipc/cost-ipc.service';
import { CostHistoryRestoreComponent } from './cost-history-restore.component';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { EchartsThemedComponent } from '../../shared/components/echarts-themed/echarts-themed.component';
import { BiggestTurnsComponent } from './biggest-turns.component';
import { ClaudeCostDriftComponent } from './claude-cost-drift.component';
import type { EChartsOption } from 'echarts';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';
import type { CostPurposeSummary } from '../../../../shared/types/cost-purpose.types';
import { spendPurposeLabel } from '../../../../shared/types/spend-purpose-labels';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { UsageWhereWentCardComponent } from '../usage-insight/usage-where-went-card.component';

// ─── Local data shapes ────────────────────────────────────────────────────────

/** Shape returned by COST_GET_SUMMARY */
export interface CostSummaryData {
  totalCost: number;
  totalAiCreditsNano?: number;
  firstCreditsAt?: number;
  providers?: string[];
  /** LT-100: portion of totalCost contributed by estimated entries. */
  totalEstimatedCost?: number;
  /** LT-100: true when the summary mixes in at least one estimated entry. */
  hasEstimatedEntries?: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  byModel: Record<string, {
    cost: number;
    aiCreditsNano?: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    requests: number;
    hasEstimated?: boolean;
    hasUnknownCost?: boolean;
  }>;
  bySession: Record<string, {
    instanceId?: string;
    provider?: string;
    aiCreditsNano?: number;
    cost: number;
    tokens: number;
    requests: number;
    hasEstimated?: boolean;
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
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  cost: number;
  /** LT-100: true when this entry's tokens/cost are a heuristic estimate. */
  isEstimated?: boolean;
}

/** Flattened row for the per-model breakdown table */
export interface ModelRow {
  hasUnknownCost?: boolean;
  model: string;
  cost: number;
  aiCreditsNano?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requests: number;
  costPct: number;
  hasEstimated: boolean;
}

/** Flattened row for the per-session breakdown table */
export interface SessionRow {
  provider?: string;
  instanceId?: string;
  aiCreditsNano: number;
  sessionId: string;
  cost: number;
  tokens: number;
  requests: number;
  costPct: number;
  hasEstimated: boolean;
}

/** Shape returned by COST_GET_BUDGET_STATUS */
interface BudgetStatusData {
  daily: { usage: number; limit: number; percentage: number };
  weekly: { usage: number; limit: number; percentage: number };
  monthly: { usage: number; limit: number; percentage: number };
}

const EMPTY_SUMMARY: CostSummaryData = {
  totalCost: 0,
  totalEstimatedCost: 0,
  hasEstimatedEntries: false,
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
  imports: [CommonModule, EchartsThemedComponent, ClaudeCostDriftComponent, BiggestTurnsComponent, AioTooltipDirective, CostHistoryRestoreComponent, UsageWhereWentCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cost-page.component.html',
  styleUrl: './cost-page.component.scss',
})
export class CostPageComponent implements OnInit, OnDestroy {
  readonly creditsTooltip = copyFor('cost.aiCredits');
  private readonly router = inject(Router);
  private readonly instances = inject(InstanceStore);
  private readonly history = inject(HistoryStore);
  private readonly settings = inject(SettingsStore);
  private readonly quotas = inject(ProviderQuotaStore);
  readonly showCost = this.settings.showCost;
  readonly breakdowns = signal(new Map<string, SessionSpendBreakdown>());
  readonly expandedSessions = signal(new Set<string>());
  private readonly loadingBreakdowns = new Set<string>();
  private readonly breakdownGenerations = new Map<string, number>();
  readonly hasCredits = computed(() => this.summary().providers?.includes('copilot') || (this.summary().totalAiCreditsNano ?? 0) > 0
    || Object.values(this.summary().bySession).some(row => row.aiCreditsNano !== undefined));
  readonly allPlanBilling = computed(() => {
    const providers = this.summary().providers ?? [];
    return providers.length > 0 && providers.every(provider => ['plan', 'credits', 'local'].includes(
      resolveBillingMode(provider, this.quotas.snapshots()[provider as ProviderId])));
  });
  costLabel(sessionId: string, instanceId?: string) {
    return resolveCostSessionLabel(sessionId, instanceId, this.instances.instances(), this.history.entries());
  }
  openSession(sessionId: string, instanceId?: string): void {
    const label = this.costLabel(sessionId, instanceId);
    if (label.state === 'open') this.instances.setSelectedInstance(label.target);
    else if (label.state === 'ended' && label.target) void this.history.loadConversation(label.target, { selectForPreview: true });
    if (label.target) void this.router.navigate(['/']);
  }
  async toggleSession(row: SessionRow): Promise<void> {
    const expanded = new Set(this.expandedSessions());
    if (expanded.has(row.sessionId)) { expanded.delete(row.sessionId); this.expandedSessions.set(expanded); return; }
    expanded.add(row.sessionId); this.expandedSessions.set(expanded);
    if (this.breakdowns().has(row.sessionId) || this.loadingBreakdowns.has(row.sessionId)) return;
    await this.loadBreakdown(row);
  }
  private async loadBreakdown(row: SessionRow): Promise<void> {
    const generation = (this.breakdownGenerations.get(row.sessionId) ?? 0) + 1;
    this.breakdownGenerations.set(row.sessionId, generation);
    this.loadingBreakdowns.add(row.sessionId);
    try {
      const response = await this.costIpc.costGetSessionBreakdown(row.instanceId ?? row.sessionId, row.sessionId);
      const data = response.success ? response.data ?? undefined : undefined;
      if (data && this.breakdownGenerations.get(row.sessionId) === generation) this.breakdowns.update(current => new Map(current).set(row.sessionId, data));
    } catch { /* a failed load is never cached, so Refresh or reopening the row retries it */ }
    finally { if (this.breakdownGenerations.get(row.sessionId) === generation) this.loadingBreakdowns.delete(row.sessionId); }
  }
  money(value: number, digits = 4): string { return this.showCost() ? `≈$${value.toFixed(digits)} at API prices` : 'Hidden'; }
  modelCostLabel(row: ModelRow): string {
    const creditsPart = row.aiCreditsNano !== undefined
      ? `${(row.aiCreditsNano / 1e9).toLocaleString('en-GB', { maximumFractionDigits: 2 })} AI credits`
      : undefined;
    const dollarPart = this.knownCostLabel(row.cost, row.hasUnknownCost === true, 6);
    if (creditsPart === undefined) return dollarPart;
    if (!row.hasUnknownCost && !(row.cost > 0)) return creditsPart;
    return `${creditsPart} · ${dollarPart}`;
  }
  sessionModelCostLabel(model: SessionSpendModel, provider?: string): string {
    if (provider === 'copilot' && model.costUsd === 0 && model.costKnown !== false) return 'AI credits';
    return this.knownCostLabel(model.costUsd, model.costKnown === false, 2);
  }
  private knownCostLabel(cost: number, hasUnknownCost: boolean, digits: number): string {
    if (!this.showCost()) return 'Hidden';
    if (hasUnknownCost && cost === 0) return 'Cost not available yet';
    return this.money(cost, digits) + (hasUnknownCost ? ' · some cost not available yet' : '');
  }
  private readonly costIpc = inject(CostIpcService);
  private readonly pollScheduler = inject(RendererPollSchedulerService);
  protected readonly estimatedTotalHint = copyFor('cost.estimatedTotal');
  protected readonly estimatedEntryHint = copyFor('cost.estimatedEntry');

  // ── Raw state signals ────────────────────────────────────────────────────

  readonly loading = signal(false);
  readonly working = signal(false);
  readonly errorMessage = signal('');
  readonly infoMessage = signal('');
  readonly budgetAlert = signal('');

  readonly summary = signal<CostSummaryData>(EMPTY_SUMMARY);
  readonly entries = signal<CostEntry[]>([]);
  readonly budgetStatus = signal<BudgetStatusData>(EMPTY_BUDGET_STATUS);
  readonly purposeSummary = signal<CostPurposeSummary | null>(null);
  readonly ephemeralUsage = signal<CodexEphemeralUsageResult | null>(null);
  readonly purposeGrouping = signal<'purpose' | 'provider'>('purpose');
  readonly purposeRows = computed(() => this.purposeGrouping() === 'purpose'
    ? this.purposeSummary()?.byPurpose ?? [] : this.purposeSummary()?.byProvider ?? []);
  readonly totalCacheReadTokens = computed(() => this.summary().totalCacheReadTokens ?? 0);
  readonly totalCacheWriteTokens = computed(() => this.summary().totalCacheWriteTokens ?? 0);

  // Budget form fields
  readonly budgetDaily = signal<number | null>(null);
  readonly budgetWeekly = signal<number | null>(null);
  readonly budgetMonthly = signal<number | null>(null);
  readonly budgetPerSession = signal<number | null>(null);

  // ── Derived aggregate signals ────────────────────────────────────────────

  readonly totalCost = computed(() => this.summary().totalCost);
  readonly totalEstimatedCost = computed(() => this.summary().totalEstimatedCost ?? 0);
  readonly hasEstimatedEntries = computed(() => this.summary().hasEstimatedEntries === true);
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
        hasUnknownCost: stats.hasUnknownCost,
        cost: stats.cost,
        aiCreditsNano: stats.aiCreditsNano,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        reasoningTokens: stats.reasoningTokens ?? 0,
        requests: stats.requests,
        costPct: total > 0 ? (stats.cost / total) * 100 : 0,
        hasEstimated: stats.hasEstimated === true,
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
        instanceId: stats.instanceId,
        provider: stats.provider,
        aiCreditsNano: stats.aiCreditsNano ?? 0,
        cost: stats.cost,
        tokens: stats.tokens,
        requests: stats.requests,
        costPct: total > 0 ? (stats.cost / total) * 100 : 0,
        hasEstimated: stats.hasEstimated === true,
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
      this.costIpc.onCostUsageRecorded(data => {
        void this.refreshAll(false);
        const entry = data as { instanceId?: string; sessionId?: string } | undefined;
        if (!entry) return;
        for (const row of this.sessionRows()) {
          if (row.sessionId !== entry.sessionId && (!entry.instanceId || row.instanceId !== entry.instanceId)) continue;
          this.breakdowns.update(current => { const next = new Map(current); next.delete(row.sessionId); return next; });
          if (this.expandedSessions().has(row.sessionId)) void this.loadBreakdown(row);
        }
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
    if (!this.history.entries().length) void this.history.loadHistory();
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
      const now = Date.now();
      const [summaryResp, entriesResp, budgetResp, purposeResp, ephemeralResp] = await Promise.all([
        this.costIpc.costGetSummary(),
        this.costIpc.costGetEntries(100),

        this.costIpc.costGetBudgetStatus(),
        this.costIpc.costGetPurposeSummary({ startTime: now - 30 * 86_400_000, endTime: now }),
        this.costIpc.costGetEphemeralUsage(100),
      ]);

      this.summary.set(this.unwrapData<CostSummaryData>(summaryResp, EMPTY_SUMMARY));
      this.entries.set(this.unwrapData<CostEntry[]>(entriesResp, []));
      this.ephemeralUsage.set(this.unwrapData<CodexEphemeralUsageResult | null>(ephemeralResp, null));
      this.purposeSummary.set(this.unwrapData<CostPurposeSummary | null>(purposeResp, null));

      const budget = this.unwrapData<BudgetStatusData>(budgetResp, EMPTY_BUDGET_STATUS);
      this.budgetStatus.set(budget);

      // Populate form fields from the status limits
      this.budgetDaily.set(budget.daily.limit > 0 ? budget.daily.limit : null);
      this.budgetWeekly.set(budget.weekly.limit > 0 ? budget.weekly.limit : null);
      this.budgetMonthly.set(budget.monthly.limit > 0 ? budget.monthly.limit : null);

      // A failed breakdown request is never cached, so Refresh retries it for
      // every expanded row that has no breakdown yet.
      const retryRows = this.sessionRows().filter(row => this.expandedSessions().has(row.sessionId)
        && !this.breakdowns().has(row.sessionId) && !this.loadingBreakdowns.has(row.sessionId));
      await Promise.all(retryRows.map(row => this.loadBreakdown(row)));
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

  formatUsage(n: number | null): string {
    return n === null ? 'Unavailable' : this.formatTokens(n);
  }

  formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  }

  purposeLabel(key: string): string {
    return spendPurposeLabel(key);
  }
}
