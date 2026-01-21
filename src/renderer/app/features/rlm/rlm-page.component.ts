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
import { Router } from '@angular/router';
import type { ContextStore, RLMSession, ContextQuery, QueryType } from '../../../../shared/types/rlm.types';
import { ElectronIpcService } from '../../core/services/electron-ipc.service';
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
        <button class="header-btn" type="button" (click)="goBack()">
          ← Back
        </button>
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
        <app-rlm-context-browser
          #browser
          [store]="store()"
          [session]="session()"
          (createStore)="createStore()"
          (startSession)="startSession()"
          (executeQueryRequest)="executeQuery($event)"
        />
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

      .header-btn {
        padding: var(--spacing-xs) var(--spacing-md);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        cursor: pointer;
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
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RlmPageComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(ElectronIpcService);
  private readonly router = inject(Router);
  private subscriptions: (() => void)[] = [];

  @ViewChild('browser')
  private browser?: RlmContextBrowserComponent;

  readonly stores = signal<ContextStore[]>([]);
  readonly selectedStoreId = signal<string>('');
  readonly store = signal<ContextStore | null>(null);
  readonly session = signal<RLMSession | null>(null);

  ngOnInit(): void {
    this.refreshStores();
    this.setupEventSubscriptions();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((unsub) => unsub());
    this.subscriptions = [];
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  async refreshStores(): Promise<void> {
    const response = await this.ipc.rlmListStores();
    const stores = this.unwrapResponse<ContextStore[]>(response) || [];
    this.stores.set(stores);

    const currentId = this.selectedStoreId();
    const nextId = stores.find((s) => s.id === currentId)?.id || stores[0]?.id || '';
    if (nextId !== currentId) {
      this.selectedStoreId.set(nextId);
    }

    if (nextId) {
      await this.loadStore(nextId);
    } else {
      this.store.set(null);
      this.session.set(null);
    }
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
      instanceId: store.instanceId,
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
        query,
      });
      const result = this.unwrapResponse<any>(response);

      const queryResult: QueryResult = {
        id: `qry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: query.type,
        content: result?.result || '',
        tokens: result?.tokensUsed || 0,
        sections: result?.sectionsAccessed || [],
        timestamp: Date.now(),
        duration: result?.duration || 0,
      };

      this.browser?.addQueryResult(queryResult);

      const refreshed = await this.ipc.rlmGetSession(session.id);
      const updatedSession = this.unwrapResponse<RLMSession | null>(refreshed);
      if (updatedSession) {
        this.session.set(updatedSession);
      }
    } catch (error) {
      const queryResult: QueryResult = {
        id: `qry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: query.type,
        content: '',
        tokens: 0,
        sections: [],
        timestamp: Date.now(),
        duration: 0,
        error: error instanceof Error ? error.message : 'Query failed',
      };

      this.browser?.addQueryResult(queryResult);
    }
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

  private setupEventSubscriptions(): void {
    this.subscriptions.push(
      this.ipc.on('rlm:store-updated', (payload: unknown) => {
        const data = payload as { storeId: string; store: ContextStore };
        if (data.storeId === this.selectedStoreId()) {
          this.store.set(data.store);
        }
      })
    );

    this.subscriptions.push(
      this.ipc.on('rlm:query-complete', async (payload: unknown) => {
        const data = payload as { sessionId: string };
        const session = this.session();
        if (session && data.sessionId === session.id) {
          const refreshed = await this.ipc.rlmGetSession(session.id);
          const updatedSession = this.unwrapResponse<RLMSession | null>(refreshed);
          if (updatedSession) {
            this.session.set(updatedSession);
          }
        }
      })
    );
  }

  private unwrapResponse<T>(response: unknown): T | null {
    if (response && typeof response === 'object' && 'success' in (response as any)) {
      const typed = response as { success: boolean; data?: T };
      return typed.success ? (typed.data ?? null) : null;
    }
    return response as T;
  }
}
