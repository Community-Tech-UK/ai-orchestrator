/**
 * Debate Page
 * Container that wires debate visualization to backend debate APIs.
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
import type {
  ActiveDebate,
  DebateResult,
  DebateStats,
} from '../../../../shared/types/debate.types';
import { DebateVisualizationComponent } from './debate-visualization.component';
import { OrchestrationIpcService } from '../../core/services/ipc/orchestration-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

const DEFAULT_DEBATE_AGENTS = 2;
const DEFAULT_DEBATE_MAX_ROUNDS = 2;

@Component({
  selector: 'app-debate-page',
  standalone: true,
  imports: [CommonModule, DebateVisualizationComponent],
  template: `
    <div class="debate-page">
      <div class="page-header">
        <div class="header-title">
          <span class="title">Debate</span>
          <span class="subtitle">Multi-agent consensus and synthesis</span>
        </div>
      </div>

      <div class="config-panel">
        <label class="field field-wide">
          <span class="label">Query</span>
          <textarea
            class="textarea"
            [value]="query()"
            placeholder="Enter the question to debate"
            (input)="onQueryChange($event)"
          ></textarea>
        </label>

        <label class="field field-wide">
          <span class="label">Context (optional)</span>
          <textarea
            class="textarea small"
            [value]="context()"
            placeholder="Provide additional context for debate agents"
            (input)="onContextChange($event)"
          ></textarea>
        </label>

        <label class="field">
          <span class="label">Agents</span>
          <input class="input" type="number" min="2" max="6" [value]="agents()" (input)="onAgentsChange($event)" />
        </label>

        <label class="field">
          <span class="label">Max Rounds</span>
          <input class="input" type="number" min="2" max="8" [value]="maxRounds()" (input)="onRoundsChange($event)" />
        </label>

        <label class="field">
          <span class="label">Convergence Threshold</span>
          <input class="input" type="number" min="0.1" max="1" step="0.05" [value]="convergenceThreshold()" (input)="onThresholdChange($event)" />
        </label>

        <div class="actions">
          <button class="btn primary" type="button" [disabled]="busy() || !canStart()" (click)="startDebate()">
            {{ busy() ? 'Starting...' : 'Start Debate' }}
          </button>
          <button class="btn" type="button" [disabled]="busy()" (click)="refreshState()">Refresh</button>
          <button class="btn danger" type="button" [disabled]="busy() || !currentDebateId()" (click)="cancelDebate()">
            Cancel
          </button>
        </div>
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      @if (activeDebates().length > 0) {
        <div class="active-list">
          <span class="active-title">Active Debates</span>
          <div class="active-items">
            @for (debate of activeDebates(); track debate.id) {
              <button
                class="active-chip"
                [class.selected]="currentDebateId() === debate.id"
                type="button"
                (click)="selectDebate(debate.id)"
              >
                <span>{{ debate.id }}</span>
                <span class="status">{{ debate.status }}</span>
              </button>
            }
          </div>
        </div>
      }

      <app-debate-visualization
        [activeDebate]="activeDebate()"
        [debateResult]="debateResult()"
        [stats]="stats()"
        (startDebate)="startDebate()"
        (cancelDebate)="cancelDebate()"
      />
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      width: 100%;
      height: 100%;
    }

    .debate-page {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow: auto;
    }

    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .header-title {
      display: flex;
      flex-direction: column;
    }

    .title {
      font-size: 18px;
      font-weight: 700;
    }

    .subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }

    .config-panel {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      min-width: 0;
    }

    .field-wide {
      grid-column: 1 / -1;
    }

    .label {
      font-size: 12px;
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
      min-height: 74px;
      resize: vertical;
    }

    .textarea.small {
      min-height: 54px;
    }

    .actions {
      grid-column: 1 / -1;
      display: flex;
      gap: var(--spacing-sm);
      justify-content: flex-end;
    }

    .btn {
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 12px;
    }

    .btn.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #fff;
    }

    .btn.danger {
      background: var(--error-color);
      border-color: var(--error-color);
      color: #fff;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .error-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
      font-size: 12px;
    }

    .active-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
    }

    .active-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
    }

    .active-items {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-xs);
    }

    .active-chip {
      display: inline-flex;
      align-items: center;
      gap: var(--spacing-sm);
      border: 1px solid var(--border-color);
      border-radius: 999px;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: 2px 10px;
      font-size: 11px;
      cursor: pointer;
    }

    .active-chip.selected {
      border-color: var(--primary-color);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary-color) 35%, transparent);
    }

    .status {
      color: var(--text-muted);
    }

    @media (max-width: 900px) {
      .config-panel {
        grid-template-columns: 1fr;
      }

      .actions {
        justify-content: flex-start;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DebatePageComponent implements OnInit, OnDestroy {
  private readonly orchestrationIpc = inject(OrchestrationIpcService);

  readonly query = signal('');
  readonly context = signal('');
  readonly agents = signal(DEFAULT_DEBATE_AGENTS);
  readonly maxRounds = signal(DEFAULT_DEBATE_MAX_ROUNDS);
  readonly convergenceThreshold = signal(0.8);

  readonly activeDebates = signal<ActiveDebate[]>([]);
  readonly activeDebate = signal<ActiveDebate | null>(null);
  readonly debateResult = signal<DebateResult | null>(null);
  readonly stats = signal<DebateStats | null>(null);
  readonly currentDebateId = signal<string | null>(null);

  readonly busy = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly canStart = computed(() => this.query().trim().length > 0);

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;

  async ngOnInit(): Promise<void> {
    await this.refreshState();
    this.startPolling();
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async startDebate(): Promise<void> {
    if (!this.canStart() || this.busy()) {
      return;
    }

    this.errorMessage.set(null);
    this.busy.set(true);
    try {
      const response = await this.orchestrationIpc.debateStart({
        query: this.query().trim(),
        context: this.context().trim() || undefined,
        config: {
          agents: this.agents(),
          maxRounds: this.maxRounds(),
          convergenceThreshold: this.convergenceThreshold(),
        },
      });

      const debateId = this.extractDebateId(response);
      if (!debateId) {
        this.setErrorFromResponse(response, 'Failed to start debate.');
        return;
      }

      this.currentDebateId.set(debateId);
      this.debateResult.set(null);
      await this.refreshState();
      this.queueFollowUpRefresh();
    } finally {
      this.busy.set(false);
    }
  }

  async cancelDebate(): Promise<void> {
    const debateId = this.currentDebateId();
    if (!debateId || this.busy()) {
      return;
    }

    this.errorMessage.set(null);
    this.busy.set(true);
    try {
      const response = await this.orchestrationIpc.debateCancel(debateId);
      if (!response.success) {
        this.setErrorFromResponse(response, 'Failed to cancel debate.');
        return;
      }
      await this.refreshState();
    } finally {
      this.busy.set(false);
    }
  }

  async refreshState(): Promise<void> {
    if (this.refreshInFlight) {
      return;
    }

    this.refreshInFlight = true;
    try {
      await Promise.all([this.refreshActiveDebates(), this.refreshStats()]);
      await this.refreshResultIfNeeded();
    } finally {
      this.refreshInFlight = false;
    }
  }

  selectDebate(debateId: string): void {
    this.currentDebateId.set(debateId);
    void this.refreshState();
  }

  onQueryChange(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.query.set(target.value);
  }

  onContextChange(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.context.set(target.value);
  }

  onAgentsChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const next = Number(target.value);
    this.agents.set(Number.isFinite(next) ? Math.min(6, Math.max(2, next)) : DEFAULT_DEBATE_AGENTS);
  }

  onRoundsChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const next = Number(target.value);
    this.maxRounds.set(Number.isFinite(next) ? Math.min(8, Math.max(2, next)) : DEFAULT_DEBATE_MAX_ROUNDS);
  }

  onThresholdChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const next = Number(target.value);
    this.convergenceThreshold.set(
      Number.isFinite(next) ? Math.min(1, Math.max(0.1, next)) : 0.8
    );
  }

  private async refreshActiveDebates(): Promise<void> {
    const response = await this.orchestrationIpc.debateGetActive();
    if (!response.success) {
      this.setErrorFromResponse(response, 'Failed to load active debates.');
      return;
    }

    const debates = this.extractData<ActiveDebate[]>(response) || [];
    this.activeDebates.set(debates);

    const selectedId = this.currentDebateId();
    if (!selectedId && debates.length > 0) {
      const latest = [...debates].sort((a, b) => b.startTime - a.startTime)[0];
      this.currentDebateId.set(latest.id);
      this.activeDebate.set(latest);
      return;
    }

    if (selectedId) {
      const selected = debates.find((debate) => debate.id === selectedId) || null;
      this.activeDebate.set(selected);
    } else {
      this.activeDebate.set(null);
    }
  }

  private async refreshStats(): Promise<void> {
    const response = await this.orchestrationIpc.debateGetStats();
    if (!response.success) {
      this.setErrorFromResponse(response, 'Failed to load debate stats.');
      return;
    }
    const stats = this.extractData<DebateStats>(response);
    this.stats.set(stats || null);
  }

  private async refreshResultIfNeeded(): Promise<void> {
    const debateId = this.currentDebateId();
    if (!debateId) {
      this.debateResult.set(null);
      return;
    }

    if (this.activeDebate()) {
      this.debateResult.set(null);
      return;
    }

    const response = await this.orchestrationIpc.debateGetResult(debateId);
    if (!response.success) {
      this.debateResult.set(null);
      return;
    }

    const result = this.extractData<DebateResult | null>(response);
    this.debateResult.set(result || null);
  }

  private extractDebateId(response: IpcResponse): string | null {
    if (!response.success) {
      return null;
    }

    if (typeof response.data === 'string') {
      return response.data;
    }

    const data = response.data as Record<string, unknown> | undefined;
    if (data && typeof data['debateId'] === 'string') {
      return data['debateId'];
    }

    return null;
  }

  private setErrorFromResponse(response: IpcResponse, fallback: string): void {
    this.errorMessage.set(response.error?.message || fallback);
  }

  private extractData<T>(response: IpcResponse): T | null {
    return response.success ? (response.data as T) : null;
  }

  private queueFollowUpRefresh(): void {
    setTimeout(() => {
      void this.refreshState();
    }, 400);
  }

  private startPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(() => {
      if (!this.currentDebateId() && this.activeDebates().length === 0) {
        return;
      }
      void this.refreshState();
    }, 2000);
  }
}
