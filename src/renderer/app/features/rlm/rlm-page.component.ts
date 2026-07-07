/**
 * RLM Page Container
 * Wires the RLM context browser UI to IPC APIs.
 */

import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  OnDestroy,
  inject,
  signal,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type {
  ContextStore,
  RLMSession,
  ContextQuery,
  QueryType
} from '../../../../shared/types/rlm.types';
import type {
  StrategyRecommendation,
  TaskPattern
} from '../../../../shared/types/self-improvement.types';
import { IpcFacadeService } from '../../core/services/ipc';
import { RlmContextBrowserComponent } from './rlm-context-browser.component';

interface QueryResult {
  id: string;
  type: QueryType;
  content: string;
  tokens: number;
  sections: string[];
  timestamp: number;
  duration: number;
  error?: string;
}

@Component({
  selector: 'app-rlm-page',
  standalone: true,
  imports: [CommonModule, RlmContextBrowserComponent],
  template: `
    <div class="rlm-page">
      <div class="rlm-header">
        <div class="header-title">
          <span class="title">RLM</span>
          <span class="subtitle">Context Manager</span>
        </div>
      </div>

      <div class="rlm-toolbar">
        <label class="toolbar-label" for="rlm-store">Store</label>
        <select
          id="rlm-store"
          class="toolbar-select"
          [value]="selectedStoreId()"
          (change)="onStoreChange($event)"
        >
          <option value="">Select a store</option>
          @for (store of stores(); track store.id) {
            <option [value]="store.id">
              {{ store.instanceId }} ({{ store.id | slice: 0 : 8 }})
            </option>
          }
        </select>
        <button class="toolbar-btn" type="button" (click)="refreshStores()">
          Refresh
        </button>
      </div>

      <div class="rlm-body">
        <div class="rlm-main">
          <app-rlm-context-browser
            #browser
            [store]="store()"
            [session]="session()"
            (createStore)="createStore()"
            (startSession)="startSession()"
            (executeQueryRequest)="executeQuery($event)"
            (sectionSelected)="handleSectionSelected($event)"
            (queryExecuted)="handleQueryExecuted($event)"
            (storeUpdated)="handleStoreUpdated($event)"
          />
        </div>

        <div class="rlm-side">
          <div class="side-card">
            <div class="side-title">Learned Patterns</div>
            @if (patterns().length > 0) {
              <ul class="pattern-list">
                @for (pattern of patterns().slice(0, 12); track pattern.type + ':' + pattern.value) {
                  <li>
                    <div class="pattern-head">
                      <span class="pattern-type">{{ pattern.type }}</span>
                      <span class="pattern-score">{{ (pattern.effectiveness * 100).toFixed(0) }}%</span>
                    </div>
                    <div class="pattern-value">{{ pattern.value }}</div>
                    <div class="pattern-meta">{{ pattern.sampleSize }} samples</div>
                  </li>
                }
              </ul>
            } @else {
              <div class="hint">No patterns recorded yet.</div>
            }
          </div>

          <div class="side-card">
            <div class="side-title">Strategy Suggestions</div>
            <label class="toolbar-label" for="rlm-context-input">Context</label>
            <textarea
              id="rlm-context-input"
              class="context-input"
              [value]="suggestionContext()"
              (input)="onSuggestionContextInput($event)"
              placeholder="Describe the task to get RLM strategy suggestions"
            ></textarea>
            <div class="side-actions">
              <button class="toolbar-btn" type="button" (click)="generateSuggestions()">
                Suggest
              </button>
            </div>

            @if (strategyRecommendation(); as recommendation) {
              <div class="recommendation">
                <div class="rec-main">
                  <span>{{ recommendation.recommendedAgent }}</span>
                  <span>{{ recommendation.recommendedModel }}</span>
                  <span>{{ (recommendation.confidence * 100).toFixed(0) }}%</span>
                </div>
                @if (recommendation.reasoning.length > 0) {
                  <ul class="reasoning">
                    @for (reason of recommendation.reasoning.slice(0, 5); track reason) {
                      <li>{{ reason }}</li>
                    }
                  </ul>
                }
              </div>
            } @else {
              <div class="hint">No suggestion generated yet.</div>
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
        flex: 1;
      }

      .rlm-page {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        height: 100%;
        padding: var(--spacing-lg);
        background: var(--bg-primary);
        color: var(--text-primary);
        width: 100%;
      }

      .rlm-header {
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

      .rlm-toolbar {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
      }

      .rlm-body {
        flex: 1;
        min-height: 0;
        width: 100%;
        display: grid;
        grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr);
        gap: var(--spacing-md);
      }

      .rlm-main,
      .rlm-side {
        min-height: 0;
      }

      .rlm-main {
        overflow: auto;
      }

      .rlm-side {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        overflow: auto;
      }

      .side-card {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        padding: var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .side-title {
        font-size: 12px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-weight: 700;
      }

      app-rlm-context-browser {
        width: 100%;
      }

      .toolbar-label {
        font-size: 12px;
        color: var(--text-muted);
      }

      .toolbar-select {
        min-width: 240px;
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-primary);
        color: var(--text-primary);
      }

      .toolbar-btn {
        padding: var(--spacing-xs) var(--spacing-md);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        cursor: pointer;
      }

      .pattern-list,
      .reasoning {
        margin: 0;
        padding-left: 16px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .pattern-head {
        display: flex;
        justify-content: space-between;
        gap: var(--spacing-xs);
        align-items: center;
      }

      .pattern-type {
        font-size: 10px;
        color: var(--text-muted);
        text-transform: uppercase;
      }

      .pattern-score {
        font-size: 11px;
        color: var(--primary-color);
        font-weight: 700;
      }

      .pattern-value {
        font-size: 12px;
        color: var(--text-primary);
      }

      .pattern-meta {
        font-size: 11px;
        color: var(--text-muted);
      }

      .context-input {
        width: 100%;
        min-height: 72px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
        resize: vertical;
        font-family: var(--font-family-mono);
      }

      .side-actions {
        display: flex;
        justify-content: flex-end;
      }

      .recommendation {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        padding: var(--spacing-xs) var(--spacing-sm);
      }

      .rec-main {
        display: flex;
        justify-content: space-between;
        gap: var(--spacing-xs);
        font-size: 11px;
        color: var(--text-primary);
      }

      .hint {
        font-size: 12px;
        color: var(--text-muted);
      }

      @media (max-width: 1200px) {
        .rlm-body {
          grid-template-columns: 1fr;
        }
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class RlmPageComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcFacadeService);
  private subscriptions: (() => void)[] = [];

  @ViewChild('browser')
  private browser?: RlmContextBrowserComponent;

  readonly stores = signal<ContextStore[]>([]);
  readonly selectedStoreId = signal<string>('');
  readonly store = signal<ContextStore | null>(null);
  readonly session = signal<RLMSession | null>(null);
  readonly patterns = signal<TaskPattern[]>([]);
  readonly strategyRecommendation = signal<StrategyRecommendation | null>(null);
  readonly suggestionContext = signal('');

  ngOnInit(): void {
    this.refreshStores();
    this.setupEventSubscriptions();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((unsub) => unsub());
    this.subscriptions = [];
  }

  async refreshStores(): Promise<void> {
    const response = await this.ipc.rlmListStores();
    const stores = this.unwrapResponse<ContextStore[]>(response) || [];
    this.stores.set(stores);

    const currentId = this.selectedStoreId();
    const nextId =
      stores.find((s) => s.id === currentId)?.id || stores[0]?.id || '';
    if (nextId !== currentId) {
      this.selectedStoreId.set(nextId);
    }

    if (nextId) {
      await this.loadStore(nextId);
    } else {
      this.store.set(null);
      this.session.set(null);
    }

    await this.refreshLearningSignals();
  }

  async loadStore(storeId: string): Promise<void> {
    const storeResponse = await this.ipc.rlmGetStore(storeId);
    const store = this.unwrapResponse<ContextStore | null>(storeResponse);
    this.store.set(store || null);

    const sessionsResponse = await this.ipc.rlmListSessions();
    const sessions = this.unwrapResponse<RLMSession[]>(sessionsResponse) || [];
    const active = sessions
      .filter((s) => s.storeId === storeId)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    this.session.set(active || null);
  }

  async createStore(): Promise<void> {
    const instanceId = `ui-${Date.now()}`;
    await this.ipc.rlmCreateStore(instanceId);
    await this.refreshStores();
  }

  async startSession(): Promise<void> {
    const store = this.store();
    if (!store) return;

    const response = await this.ipc.rlmStartSession({
      storeId: store.id,
      instanceId: store.instanceId
    });
    const session = this.unwrapResponse<RLMSession | null>(response);
    this.session.set(session || null);
  }

  async executeQuery(query: ContextQuery): Promise<void> {
    const session = this.session();
    if (!session) return;

    try {
      const response = await this.ipc.rlmExecuteQuery({
        sessionId: session.id,
        query
      });
      const result = this.unwrapResponse<{ result?: string; tokensUsed?: number; sectionsAccessed?: string[]; duration?: number }>(response);

      const queryResult: QueryResult = {
        id: `qry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: query.type,
        content: result?.result || '',
        tokens: result?.tokensUsed || 0,
        sections: result?.sectionsAccessed || [],
        timestamp: Date.now(),
        duration: result?.duration || 0
      };

      this.browser?.addQueryResult(queryResult);

      const refreshed = await this.ipc.rlmGetSession(session.id);
      const updatedSession = this.unwrapResponse<RLMSession | null>(refreshed);
      if (updatedSession) {
        this.session.set(updatedSession);
      }

      await this.refreshLearningSignals();
    } catch (error) {
      const queryResult: QueryResult = {
        id: `qry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: query.type,
        content: '',
        tokens: 0,
        sections: [],
        timestamp: Date.now(),
        duration: 0,
        error: error instanceof Error ? error.message : 'Query failed'
      };

      this.browser?.addQueryResult(queryResult);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handleSectionSelected(_section?: unknown): Promise<void> {
    const store = this.store();
    if (!store) return;

    // Refresh store snapshot to keep selection in sync
    const storeResponse = await this.ipc.rlmGetStore(store.id);
    const refreshed = this.unwrapResponse<ContextStore | null>(storeResponse);
    if (refreshed) {
      this.store.set(refreshed);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handleQueryExecuted(_result?: unknown): Promise<void> {
    const session = this.session();
    if (!session) return;

    const refreshed = await this.ipc.rlmGetSession(session.id);
    const updatedSession = this.unwrapResponse<RLMSession | null>(refreshed);
    if (updatedSession) {
      this.session.set(updatedSession);
    }

    await this.refreshLearningSignals();
  }

  async handleStoreUpdated(store: ContextStore): Promise<void> {
    this.store.set(store);
    const storesResponse = await this.ipc.rlmListStores();
    const stores = this.unwrapResponse<ContextStore[]>(storesResponse) || [];
    this.stores.set(stores);
    await this.refreshLearningSignals();
  }

  onStoreChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const storeId = target.value;
    this.selectedStoreId.set(storeId);
    if (storeId) {
      this.loadStore(storeId);
    } else {
      this.store.set(null);
      this.session.set(null);
    }
  }

  onSuggestionContextInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.suggestionContext.set(target.value);
  }

  async generateSuggestions(): Promise<void> {
    const context = this.suggestionContext().trim();
    if (!context) {
      this.strategyRecommendation.set(null);
      return;
    }

    const response = await this.ipc.rlmGetStrategySuggestions(context, 5);
    const recommendation = this.unwrapResponse<StrategyRecommendation>(response);
    this.strategyRecommendation.set(recommendation || null);
  }

  private setupEventSubscriptions(): void {
    this.subscriptions.push(
      this.ipc.getApi()?.onRlmStoreUpdated((payload: unknown) => {
        const data = payload as { storeId: string; store: ContextStore };
        if (data.storeId === this.selectedStoreId()) {
          this.store.set(data.store);
        }
      }) ?? (() => { /* noop */ })
    );

    this.subscriptions.push(
      this.ipc.getApi()?.onRlmQueryComplete(async (payload: unknown) => {
        const data = payload as { sessionId: string };
        const session = this.session();
        if (session && data.sessionId === session.id) {
          const refreshed = await this.ipc.rlmGetSession(session.id);
          const updatedSession = this.unwrapResponse<RLMSession | null>(
            refreshed
          );
          if (updatedSession) {
            this.session.set(updatedSession);
          }
        }
      }) ?? (() => { /* noop */ })
    );
  }

  private async refreshLearningSignals(): Promise<void> {
    const patternsResponse = await this.ipc.rlmGetPatterns(0.4);
    const patterns = this.unwrapResponse<TaskPattern[]>(patternsResponse) || [];
    this.patterns.set(patterns);

    if (this.suggestionContext().trim().length > 0) {
      await this.generateSuggestions();
    }
  }

  private unwrapResponse<T>(response: unknown): T | null {
    if (
      response &&
      typeof response === 'object' &&
      'success' in (response as Record<string, unknown>)
    ) {
      const typed = response as { success: boolean; data?: T };
      return typed.success ? (typed.data ?? null) : null;
    }
    return response as T;
  }
}
