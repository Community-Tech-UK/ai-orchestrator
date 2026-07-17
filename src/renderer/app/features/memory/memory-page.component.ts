/**
 * Memory Page
 * Container that wires memory browser UI to Memory-R1 and Unified Memory IPC APIs.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type {
  MemoryEntry,
  MemoryR1Stats,
} from '../../../../shared/types/memory-r1.types';
import type {
  LearnedPattern,
  MemoryType,
  SessionMemory,
  WorkflowMemory,
} from '../../../../shared/types/unified-memory.types';
import { MemoryBrowserComponent } from './memory-browser.component';
import { MemoryIpcService } from '../../core/services/ipc/memory-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface MemoryEntryView extends MemoryEntry {
  type?: MemoryType;
}

@Component({
  selector: 'app-memory-page',
  standalone: true,
  imports: [CommonModule, MemoryBrowserComponent],
  template: `
    <div class="page">
      <div class="page-header">
        <div class="header-title">
          <span class="title">Memory</span>
          <span class="subtitle">Memory retrieval, learned patterns, and session history</span>
        </div>
      </div>

      <div class="toolbar">
        <label class="field field-wide">
          <span class="label">Retrieve Query</span>
          <input
            class="input"
            type="text"
            [value]="query()"
            placeholder="e.g. auth bug fix context"
            (input)="onQueryInput($event)"
          />
        </label>

        <label class="field">
          <span class="label">Task ID</span>
          <input class="input" type="text" [value]="taskId()" (input)="onTaskIdInput($event)" />
        </label>

        <label class="field">
          <span class="label">Pattern Min Success</span>
          <input
            class="input"
            type="number"
            min="0"
            max="1"
            step="0.05"
            [value]="patternMinSuccess()"
            (input)="onPatternMinSuccessInput($event)"
          />
        </label>

        <div class="actions">
          <button class="btn primary" type="button" [disabled]="working()" (click)="retrieveMemories()">Retrieve</button>
          <button class="btn" type="button" [disabled]="working()" (click)="refreshMetadata()">Refresh</button>
        </div>
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <div class="content">
        <div class="main-panel">
          <app-memory-browser
            [entries]="entries()"
            (entrySelected)="onEntrySelected($event)"
            (entryDeleted)="onEntryDeleted($event)"
            (navigateToEntry)="onNavigateToEntry($event)"
          />
        </div>

        <div class="side-panel">
          <div class="panel-card">
            <div class="panel-title">Memory Stats</div>
            @if (stats(); as s) {
              <div class="stat-row"><span>Total entries</span><span>{{ s.totalEntries }}</span></div>
              <div class="stat-row"><span>Total tokens</span><span>{{ s.totalTokens }}</span></div>
              <div class="stat-row"><span>Avg relevance</span><span>{{ s.avgRelevanceScore.toFixed(2) }}</span></div>
              <div class="stat-row"><span>Recent retrievals</span><span>{{ s.recentRetrievals }}</span></div>
              <div class="stat-row"><span>Cache hit rate</span><span>{{ (s.cacheHitRate * 100).toFixed(0) }}%</span></div>
            } @else {
              <div class="hint">Stats unavailable.</div>
            }
          </div>

          <div class="panel-card">
            <div class="panel-title">Learned Patterns</div>
            @if (patterns().length > 0) {
              <ul class="list">
                @for (pattern of patterns(); track pattern.id) {
                  <li>
                    <span class="strong">{{ pattern.pattern }}</span>
                    <span class="muted">{{ (pattern.successRate * 100).toFixed(0) }}% • {{ pattern.usageCount }} uses</span>
                  </li>
                }
              </ul>
            } @else {
              <div class="hint">No learned patterns available.</div>
            }
          </div>

          <div class="panel-card">
            <div class="panel-title">Session History</div>
            @if (sessions().length > 0) {
              <ul class="list">
                @for (session of sessions(); track session.sessionId) {
                  <li>
                    <span class="strong">{{ session.sessionId }}</span>
                    <span class="muted">{{ session.outcome }} • {{ formatTime(session.timestamp) }}</span>
                  </li>
                }
              </ul>
            } @else {
              <div class="hint">No session history available.</div>
            }
          </div>

          <div class="panel-card">
            <div class="panel-title">Workflow Memory</div>
            @if (workflows().length > 0) {
              <ul class="list">
                @for (workflow of workflows(); track workflow.id) {
                  <li>
                    <span class="strong">{{ workflow.name }}</span>
                    <span class="muted">{{ (workflow.successRate * 100).toFixed(0) }}% • {{ workflow.steps.length }} steps</span>
                  </li>
                }
              </ul>
            } @else {
              <div class="hint">No workflow memories stored.</div>
            }
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
      }

      .title {
        font-size: 18px;
        font-weight: 700;
      }

      .subtitle {
        font-size: 12px;
        color: var(--text-muted);
      }

      .toolbar {
        display: grid;
        grid-template-columns: minmax(260px, 2fr) minmax(180px, 1fr) minmax(180px, 1fr) auto;
        gap: var(--spacing-sm);
        align-items: end;
        padding: var(--spacing-md);
        border-radius: var(--radius-md);
        border: 1px solid var(--border-color);
        background: var(--bg-secondary);
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
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
      }

      .actions {
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

      .content {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
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
      }

      .stat-row {
        display: flex;
        justify-content: space-between;
        gap: var(--spacing-sm);
        font-size: 12px;
        color: var(--text-secondary);
      }

      .list {
        margin: 0;
        padding-left: 16px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      li {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .strong {
        font-size: 12px;
        color: var(--text-primary);
        overflow-wrap: anywhere;
      }

      .muted,
      .hint {
        font-size: 11px;
        color: var(--text-muted);
      }

      @media (max-width: 1200px) {
        .toolbar {
          grid-template-columns: 1fr;
        }

        .content {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemoryPageComponent implements OnInit, OnDestroy {
  private readonly memoryIpc = inject(MemoryIpcService);
  private unsubscribes: (() => void)[] = [];

  readonly entries = signal<MemoryEntryView[]>([]);
  readonly stats = signal<MemoryR1Stats | null>(null);
  readonly processStats = signal<unknown>(null);
  readonly memoryWarning = signal<string | null>(null);
  readonly patterns = signal<LearnedPattern[]>([]);
  readonly sessions = signal<SessionMemory[]>([]);
  readonly workflows = signal<WorkflowMemory[]>([]);

  readonly query = signal('');
  readonly taskId = signal(`memory-${Date.now()}`);
  readonly patternMinSuccess = signal(0.5);

  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    // Subscribe to memory stats events
    this.unsubscribes.push(
      this.memoryIpc.onMemoryStatsUpdate((stats) => {
        this.processStats.set(stats);
      })
    );
    this.unsubscribes.push(
      this.memoryIpc.onMemoryWarning((warning) => {
        const data = warning as { message?: string };
        this.memoryWarning.set(data?.message || 'Memory pressure detected');
      })
    );
    this.unsubscribes.push(
      this.memoryIpc.onMemoryCritical((alert) => {
        const data = alert as { message?: string };
        this.memoryWarning.set(data?.message || 'Critical memory pressure!');
      })
    );

    // Load initial process memory stats
    this.memoryIpc.getMemoryStats().then(resp => {
      if (resp.success && resp.data) {
        this.processStats.set(resp.data);
      }
    }).catch(() => { /* best-effort */ });

    await this.refreshMetadata();
    await this.retrieveMemories();
  }

  ngOnDestroy(): void {
    for (const unsub of this.unsubscribes) {
      unsub();
    }
  }

  async retrieveMemories(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);

    try {
      const query = this.query().trim() || 'recent context';
      const response = await this.memoryIpc.memoryR1Retrieve({
        query,
        taskId: this.taskId().trim() || `memory-${Date.now()}`,
      });

      if (!response.success) {
        this.errorMessage.set(response.error?.message || 'Failed to retrieve memories.');
        return;
      }

      const entries = this.unwrapData<MemoryEntry[]>(response, []).map((entry) => ({
        ...entry,
        type: this.inferMemoryType(entry),
      }));
      this.entries.set(entries);
      this.infoMessage.set(`Retrieved ${entries.length} memories.`);
      await this.refreshMetadata(false);
    } finally {
      this.working.set(false);
    }
  }

  async refreshMetadata(showBusy = true): Promise<void> {
    if (showBusy) {
      this.working.set(true);
    }
    this.errorMessage.set(null);

    try {
      const [statsResp, patternsResp, sessionsResp, workflowsResp] = await Promise.all([
        this.memoryIpc.memoryR1GetStats(),
        this.memoryIpc.unifiedMemoryGetPatterns(this.patternMinSuccess()),
        this.memoryIpc.unifiedMemoryGetSessions(20),
        this.memoryIpc.unifiedMemoryGetWorkflows(),
      ]);

      this.stats.set(this.unwrapData<MemoryR1Stats | null>(statsResp, null));
      this.patterns.set(this.unwrapData<LearnedPattern[]>(patternsResp, []));
      this.sessions.set(this.unwrapData<SessionMemory[]>(sessionsResp, []));
      this.workflows.set(this.unwrapData<WorkflowMemory[]>(workflowsResp, []));
    } finally {
      if (showBusy) {
        this.working.set(false);
      }
    }
  }

  onEntrySelected(entry: MemoryEntryView): void {
    this.infoMessage.set(`Selected memory ${entry.id}.`);
  }

  async onEntryDeleted(entryId: string): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);

    try {
      const response = await this.memoryIpc.memoryR1DeleteEntry(entryId);
      if (!response.success) {
        this.errorMessage.set(response.error?.message || 'Failed to delete memory entry.');
        return;
      }

      this.entries.update((entries) => entries.filter((entry) => entry.id !== entryId));
      this.infoMessage.set('Memory entry deleted.');
      await this.refreshMetadata(false);
    } finally {
      this.working.set(false);
    }
  }

  async onNavigateToEntry(entryId: string): Promise<void> {
    const response = await this.memoryIpc.memoryR1GetEntry(entryId);
    if (!response.success) {
      this.errorMessage.set(response.error?.message || 'Failed to load linked memory entry.');
      return;
    }

    const entry = this.unwrapData<MemoryEntry | null>(response, null);
    if (!entry) {
      this.errorMessage.set('Linked memory entry not found.');
      return;
    }

    const view: MemoryEntryView = { ...entry, type: this.inferMemoryType(entry) };
    this.entries.update((existing) => {
      if (existing.some((item) => item.id === view.id)) {
        return existing;
      }
      return [view, ...existing];
    });
    this.infoMessage.set(`Loaded linked entry ${entry.id}.`);
  }

  onQueryInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  onTaskIdInput(event: Event): void {
    this.taskId.set((event.target as HTMLInputElement).value);
  }

  onPatternMinSuccessInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.patternMinSuccess.set(Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5);
    void this.refreshMetadata(false);
  }

  formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  private inferMemoryType(entry: MemoryEntry): MemoryType {
    if (entry.tags.includes('procedural') || entry.sourceType === 'tool_result') {
      return 'procedural';
    }
    if (entry.tags.includes('semantic') || entry.sourceType === 'agent_output') {
      return 'semantic';
    }
    if (entry.tags.includes('short_term')) {
      return 'short_term';
    }
    if (entry.tags.includes('long_term') || entry.sourceType === 'derived') {
      return 'long_term';
    }
    return 'episodic';
  }

  private unwrapData<T>(response: IpcResponse, fallback: T): T {
    return response.success ? ((response.data as T) ?? fallback) : fallback;
  }
}
