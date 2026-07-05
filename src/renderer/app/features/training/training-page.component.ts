/**
 * Training Page
 * Container that wires GRPO training dashboard and controls to backend training IPC APIs.
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
import {
  GrpoDashboardComponent,
  LearningInsight,
  TaskOutcome,
  TaskPattern,
  TrainingStats,
} from './grpo-dashboard.component';
import { TrainingIpcService } from '../../core/services/ipc/training-ipc.service';
import { MemoryIpcService } from '../../core/services/ipc/memory-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface RawTrainingStats {
  totalOutcomes: number;
  totalBatches: number;
  averageReward: number;
  averageAdvantage: number;
  lastUpdated: number;
}

interface RawTrainingOutcome {
  taskId: string;
  prompt: string;
  response: string;
  reward: number;
  strategy?: string;
  context?: string;
  timestamp: number;
}

interface StrategyRow {
  strategy: string;
  avgReward: number;
  count: number;
}

interface RewardTrend {
  improving: boolean;
  slope: number;
  recent: number[];
}

@Component({
  selector: 'app-training-page',
  standalone: true,
  imports: [CommonModule, GrpoDashboardComponent],
  template: `
    <div class="page">
      <div class="page-header">
        <div class="header-title">
          <span class="title">Training</span>
          <span class="subtitle">GRPO outcomes, trends, top strategies, and config import/export</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="working()" (click)="refreshAll()">Refresh</button>
        </div>
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <div class="layout">
        <div class="main-panel">
          <app-grpo-dashboard
            [stats]="dashboardStats()"
            [patterns]="patterns()"
            [insights]="insights()"
            [outcomes]="outcomes()"
            [isTrainingActive]="isTrainingActive()"
            (refreshData)="refreshAll()"
            (exportData)="exportTrainingData()"
          />
        </div>

        <div class="side-panel">
          <div class="panel-card">
            <div class="panel-title">Record Outcome</div>
            <label class="field">
              <span class="label">Task ID</span>
              <input class="input" type="text" [value]="taskId()" (input)="onTaskIdInput($event)" />
            </label>
            <label class="field">
              <span class="label">Prompt</span>
              <textarea class="textarea small" [value]="prompt()" (input)="onPromptInput($event)"></textarea>
            </label>
            <label class="field">
              <span class="label">Response</span>
              <textarea class="textarea small" [value]="response()" (input)="onResponseInput($event)"></textarea>
            </label>
            <div class="row two-col">
              <label class="field">
                <span class="label">Reward (0-1)</span>
                <input class="input" type="number" min="0" max="1" step="0.01" [value]="reward()" (input)="onRewardInput($event)" />
              </label>
              <label class="field">
                <span class="label">Strategy</span>
                <input class="input" type="text" [value]="strategy()" (input)="onStrategyInput($event)" />
              </label>
            </div>
            <label class="field">
              <span class="label">Context (optional)</span>
              <textarea class="textarea" [value]="context()" (input)="onContextInput($event)"></textarea>
            </label>
            <div class="row">
              <button class="btn primary" type="button" [disabled]="working()" (click)="recordOutcome()">Record</button>
            </div>
          </div>

          <div class="panel-card">
            <div class="panel-title">Trend & Strategies</div>
            @if (trend(); as t) {
              <div class="meta">Trend: {{ t.improving ? 'improving' : 'flat/declining' }}</div>
              <div class="meta">Slope: {{ t.slope.toFixed(4) }}</div>
              @if (t.recent.length > 0) {
                <div class="sparkline">
                  @for (value of t.recent; track $index) {
                    <span class="spark-item">{{ value.toFixed(2) }}</span>
                  }
                </div>
              }
            } @else {
              <div class="hint">Trend unavailable.</div>
            }

            <label class="field">
              <span class="label">Top strategy limit</span>
              <input
                class="input"
                type="number"
                min="1"
                max="50"
                [value]="strategyLimit()"
                (input)="onStrategyLimitInput($event)"
              />
            </label>

            @if (topStrategies().length > 0) {
              <ul class="list">
                @for (item of topStrategies(); track item.strategy) {
                  <li>
                    <span class="strong">{{ item.strategy }}</span>
                    <span class="muted">reward {{ item.avgReward.toFixed(2) }} • {{ item.count }} samples</span>
                  </li>
                }
              </ul>
            } @else {
              <div class="hint">No strategy data yet.</div>
            }
          </div>

          <div class="panel-card">
            <div class="panel-title">Import / Export</div>
            <div class="row">
              <button class="btn" type="button" [disabled]="working()" (click)="exportTrainingData()">Export JSON</button>
            </div>
            <textarea
              class="textarea"
              [value]="importJson()"
              (input)="onImportJsonInput($event)"
              placeholder="Paste exported training JSON (outcomes + batches)"
            ></textarea>
            <div class="row">
              <button class="btn" type="button" [disabled]="working()" (click)="importTrainingData()">Import JSON</button>
            </div>
          </div>

          <div class="panel-card">
            <div class="panel-title">Configure</div>
            <textarea class="textarea" [value]="configJson()" (input)="onConfigJsonInput($event)"></textarea>
            <div class="row">
              <button class="btn" type="button" [disabled]="working()" (click)="applyConfig()">Apply Config</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
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
      }

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

      .btn {
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
        cursor: pointer;
      }

      .btn.primary {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: #fff;
      }

      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .error-banner,
      .info-banner {
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

      .layout {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, 2fr) minmax(340px, 1fr);
        gap: var(--spacing-md);
      }

      .main-panel,
      .side-panel {
        min-height: 0;
      }

      .main-panel {
        overflow: auto;
      }

      .side-panel {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        overflow: auto;
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
        letter-spacing: 0.04em;
        text-transform: uppercase;
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

      .input,
      .textarea {
        width: 100%;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
      }

      .textarea {
        min-height: 84px;
        resize: vertical;
        font-family: var(--font-family-mono);
      }

      .textarea.small {
        min-height: 64px;
      }

      .row {
        display: flex;
        gap: var(--spacing-xs);
        align-items: center;
      }

      .row.two-col {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--spacing-xs);
      }

      .meta,
      .hint,
      .muted {
        font-size: 12px;
        color: var(--text-muted);
      }

      .strong {
        font-size: 12px;
        color: var(--text-primary);
        font-weight: 600;
      }

      .sparkline {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }

      .spark-item {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        padding: 2px 6px;
        font-size: 10px;
        color: var(--text-secondary);
      }

      .list {
        margin: 0;
        padding-left: 16px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      li {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      @media (max-width: 1200px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingPageComponent implements OnInit, OnDestroy {
  private readonly trainingIpc = inject(TrainingIpcService);
  private readonly memoryIpc = inject(MemoryIpcService);

  readonly dashboardStats = signal<TrainingStats | null>(null);
  readonly patterns = signal<TaskPattern[]>([]);
  readonly insights = signal<LearningInsight[]>([]);
  readonly outcomes = signal<TaskOutcome[]>([]);
  readonly trend = signal<RewardTrend | null>(null);
  readonly topStrategies = signal<StrategyRow[]>([]);

  readonly taskId = signal(`task-${Date.now()}`);
  readonly prompt = signal('');
  readonly response = signal('');
  readonly reward = signal(0.7);
  readonly strategy = signal('');
  readonly context = signal('');

  readonly importJson = signal('');
  readonly configJson = signal('{\n  "groupSize": 8,\n  "learningRate": 0.001\n}');
  readonly strategyLimit = signal(10);

  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  readonly isTrainingActive = computed(() =>
    (this.dashboardStats()?.totalOutcomes || 0) > 0 || this.topStrategies().length > 0
  );

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async ngOnInit(): Promise<void> {
    await this.refreshAll();
    this.pollTimer = setInterval(() => {
      void this.refreshAll(false);
    }, 8000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async refreshAll(showBusy = true): Promise<void> {
    if (showBusy) {
      this.working.set(true);
    }
    this.errorMessage.set(null);

    try {
      const [statsResp, trendResp, strategiesResp, exportResp] = await Promise.all([
        this.trainingIpc.trainingGetStats(),
        this.trainingIpc.trainingGetTrend(),
        this.trainingIpc.trainingGetTopStrategies(this.strategyLimit()),
        this.trainingIpc.trainingExportData(),
      ]);

      const rawStats = this.unwrapData<RawTrainingStats | null>(statsResp, null);
      const trend = this.unwrapData<RewardTrend | null>(trendResp, null);
      const strategies = this.unwrapData<StrategyRow[]>(strategiesResp, []);
      const exportData = this.unwrapData<
        | {
            outcomes?: RawTrainingOutcome[];
            batches?: unknown[];
            stats?: Record<string, unknown>;
          }
        | null
      >(exportResp, null);

      this.topStrategies.set(strategies);
      this.trend.set(trend);

      // Merge learning patterns from memory service
      const [learningPatternsResp, learningSuggestionsResp] = await Promise.all([
        this.memoryIpc.learningGetPatterns(0.5).catch(() => ({ success: false } as IpcResponse)),
        this.memoryIpc.learningGetSuggestions('training-dashboard', 5).catch(() => ({ success: false } as IpcResponse)),
      ]);
      const learningPatterns = this.unwrapData<{ id: string; pattern: string; successRate: number }[]>(learningPatternsResp, []);
      const learningSuggestions = this.unwrapData<{ suggestion: string; confidence: number }[]>(learningSuggestionsResp, []);

      const now = Date.now();
      const patterns = this.buildPatterns(strategies);
      // Append learning patterns as additional task patterns
      for (const lp of learningPatterns) {
        if (!patterns.some(p => p.value === lp.pattern)) {
          patterns.push({
            type: 'context_selection',
            value: lp.pattern,
            effectiveness: lp.successRate,
            sampleSize: 1,
            lastUpdated: now,
          });
        }
      }

      const insights = this.buildInsights(strategies, trend);
      // Append learning suggestions as additional insights
      for (const ls of learningSuggestions) {
        insights.push({
          id: `learn-${now}-${Math.random().toString(36).slice(2, 6)}`,
          type: ls.confidence > 0.7 ? 'optimization' : 'recommendation',
          description: ls.suggestion,
          confidence: ls.confidence,
          evidence: ['From learning service'],
          taskTypes: ['learning'],
          createdAt: now,
          appliedCount: 0,
          successRate: ls.confidence,
        });
      }
      const outcomes = (exportData?.outcomes || []).map((outcome, index) =>
        this.toDashboardOutcome(outcome, index)
      );

      this.patterns.set(patterns);
      this.insights.set(insights);
      this.outcomes.set(outcomes);
      this.dashboardStats.set(this.toDashboardStats(rawStats, patterns, insights));
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      if (showBusy) {
        this.working.set(false);
      }
    }
  }

  async recordOutcome(): Promise<void> {
    if (!this.taskId().trim() || !this.prompt().trim() || !this.response().trim()) {
      this.errorMessage.set('Task ID, prompt, and response are required to record an outcome.');
      return;
    }

    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      const reward = Math.max(0, Math.min(1, this.reward()));
      const response = await this.trainingIpc.trainingRecordOutcome({
        taskId: this.taskId().trim(),
        prompt: this.prompt().trim(),
        response: this.response().trim(),
        reward,
        strategy: this.strategy().trim() || undefined,
        context: this.context().trim() || undefined,
      });

      if (!response.success) {
        this.errorMessage.set(response.error?.message || 'Failed to record training outcome.');
        return;
      }

      this.infoMessage.set('Outcome recorded.');
      this.taskId.set(`task-${Date.now()}`);
      await this.refreshAll(false);
    } finally {
      this.working.set(false);
    }
  }

  async applyConfig(): Promise<void> {
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(this.configJson()) as Record<string, unknown>;
    } catch {
      this.errorMessage.set('Training config must be valid JSON.');
      return;
    }

    this.working.set(true);
    this.errorMessage.set(null);

    try {
      const response = await this.trainingIpc.trainingConfigure(config);
      if (!response.success) {
        this.errorMessage.set(response.error?.message || 'Failed to apply training config.');
        return;
      }
      this.infoMessage.set('Training config applied.');
      await this.refreshAll(false);
    } finally {
      this.working.set(false);
    }
  }

  async importTrainingData(): Promise<void> {
    const raw = this.importJson().trim();
    if (!raw) {
      this.errorMessage.set('Provide JSON data to import.');
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.errorMessage.set('Import payload must be valid JSON.');
      return;
    }

    this.working.set(true);
    this.errorMessage.set(null);

    try {
      const response = await this.trainingIpc.trainingImportData(parsed);
      if (!response.success) {
        this.errorMessage.set(response.error?.message || 'Failed to import training data.');
        return;
      }
      this.infoMessage.set('Training data imported.');
      await this.refreshAll(false);
    } finally {
      this.working.set(false);
    }
  }

  async exportTrainingData(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);

    try {
      const response = await this.trainingIpc.trainingExportData();
      if (!response.success) {
        this.errorMessage.set(response.error?.message || 'Failed to export training data.');
        return;
      }

      const data = response.data ?? {};
      const content = JSON.stringify(data, null, 2);
      this.downloadFile(`training-export-${Date.now()}.json`, content, 'application/json');
      this.infoMessage.set('Training export downloaded.');
    } finally {
      this.working.set(false);
    }
  }

  onTaskIdInput(event: Event): void {
    this.taskId.set((event.target as HTMLInputElement).value);
  }

  onPromptInput(event: Event): void {
    this.prompt.set((event.target as HTMLTextAreaElement).value);
  }

  onResponseInput(event: Event): void {
    this.response.set((event.target as HTMLTextAreaElement).value);
  }

  onRewardInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.reward.set(Number.isFinite(value) ? value : 0);
  }

  onStrategyInput(event: Event): void {
    this.strategy.set((event.target as HTMLInputElement).value);
  }

  onContextInput(event: Event): void {
    this.context.set((event.target as HTMLTextAreaElement).value);
  }

  onImportJsonInput(event: Event): void {
    this.importJson.set((event.target as HTMLTextAreaElement).value);
  }

  onConfigJsonInput(event: Event): void {
    this.configJson.set((event.target as HTMLTextAreaElement).value);
  }

  onStrategyLimitInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    const normalized = Number.isFinite(value) ? Math.max(1, Math.min(50, value)) : 10;
    this.strategyLimit.set(normalized);
    void this.refreshAll(false);
  }

  private toDashboardStats(
    stats: RawTrainingStats | null,
    patterns: TaskPattern[],
    insights: LearningInsight[]
  ): TrainingStats | null {
    if (!stats) {
      return null;
    }

    return {
      totalOutcomes: stats.totalOutcomes,
      successRate: this.clamp01(stats.averageReward),
      patternCount: patterns.length,
      insightCount: insights.length,
      experienceCount: stats.totalBatches,
      topPatterns: patterns.slice(0, 10),
      recentInsights: insights.slice(0, 10),
    };
  }

  private buildPatterns(strategies: StrategyRow[]): TaskPattern[] {
    const now = Date.now();
    return strategies.map((strategy) => ({
      type: 'prompt_structure',
      value: strategy.strategy,
      effectiveness: this.clamp01(strategy.avgReward),
      sampleSize: strategy.count,
      lastUpdated: now,
    }));
  }

  private buildInsights(
    strategies: StrategyRow[],
    trend: RewardTrend | null
  ): LearningInsight[] {
    const insights: LearningInsight[] = [];
    const now = Date.now();

    if (trend) {
      insights.push({
        id: `trend-${now}`,
        type: trend.improving ? 'optimization' : 'recommendation',
        description: trend.improving
          ? 'Reward trend is improving. Keep current strategy mix.'
          : 'Reward trend is not improving. Consider revising strategy selection.',
        confidence: Math.min(1, Math.abs(trend.slope) * 15),
        evidence: [`Slope: ${trend.slope.toFixed(4)}`, `Points: ${trend.recent.length}`],
        taskTypes: ['grpo-training'],
        createdAt: now,
        appliedCount: 0,
        successRate: trend.improving ? 0.75 : 0.4,
      });
    }

    for (const strategy of strategies.slice(0, 5)) {
      insights.push({
        id: `strategy-${strategy.strategy}`,
        type: 'pattern',
        description: `Strategy "${strategy.strategy}" has avg reward ${strategy.avgReward.toFixed(2)} over ${strategy.count} samples.`,
        confidence: Math.min(1, strategy.count / 20),
        evidence: [`avgReward=${strategy.avgReward.toFixed(2)}`, `samples=${strategy.count}`],
        taskTypes: ['grpo-training'],
        createdAt: now,
        appliedCount: strategy.count,
        successRate: this.clamp01(strategy.avgReward),
      });
    }

    return insights;
  }

  private toDashboardOutcome(outcome: RawTrainingOutcome, index: number): TaskOutcome {
    const reward = this.clamp01(outcome.reward);
    return {
      id: `${outcome.taskId}-${outcome.timestamp}-${index}`,
      instanceId: 'training',
      taskType: 'grpo-training',
      taskDescription: outcome.taskId,
      prompt: outcome.prompt,
      context: outcome.context,
      agentUsed: outcome.strategy || 'default',
      modelUsed: 'n/a',
      toolsUsed: [],
      tokensUsed: 0,
      duration: 0,
      success: reward >= 0.6,
      completionScore: reward,
      patterns: [],
      timestamp: outcome.timestamp,
    };
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(1, value));
  }

  private unwrapData<T>(response: IpcResponse, fallback: T): T {
    return response.success ? ((response.data as T) ?? fallback) : fallback;
  }

  private downloadFile(filename: string, content: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }
}
