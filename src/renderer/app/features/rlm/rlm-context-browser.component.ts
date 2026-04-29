/**
 * RLM Context Browser Component
 *
 * Browse and manage RLM (Recursive Language Model) context stores:
 * - Context sections display (file, conversation, tool_output, external, summary)
 * - Query engine operations (grep, slice, sub_query, summarize)
 * - Token usage and cost tracking metrics
 * - Session statistics and savings visualization
 */

import {
  Component,
  input,
  output,
  signal,
  ChangeDetectionStrategy,
  HostListener,
  OnInit,
  OnDestroy,
  inject
} from '@angular/core';
import type {
  ContextStore,
  ContextSection,
  ContextQuery,
  RLMSession,
  QueryType
} from '../../../../shared/types/rlm.types';
import { ElectronIpcService } from '../../core/services/ipc';
import { ContextStatsComponent } from './context-browser/context-stats.component';
import { ContextSessionStatsComponent } from './context-browser/context-session-stats.component';
import {
  ContextQueryPanelComponent,
  SavedQueryTemplate
} from './context-browser/context-query-panel.component';
import {
  ContextQueryResultsComponent,
  QueryResult
} from './context-browser/context-query-results.component';
import { ContextSectionsPanelComponent } from './context-browser/context-sections-panel.component';
import { ContextSectionDetailComponent } from './context-browser/context-section-detail.component';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';

/** Toast notification interface */
interface ToastNotification {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
  timestamp: number;
}

@Component({
  selector: 'app-rlm-context-browser',
  standalone: true,
  imports: [
    ContextStatsComponent,
    ContextSessionStatsComponent,
    ContextQueryPanelComponent,
    ContextQueryResultsComponent,
    ContextSectionsPanelComponent,
    ContextSectionDetailComponent
  ],
  template: `
    <div class="rlm-container">
      <!-- Header -->
      <div class="rlm-header">
        <div class="header-left">
          <span class="rlm-icon">🧩</span>
          <span class="rlm-title">RLM Context Manager</span>
          @if (store()) {
            <span class="section-count"
              >{{ store()!.sections.length }} sections</span
            >
          }
        </div>
        <div class="header-actions">
          @if (session()) {
            <div class="session-badge active">Session Active</div>
          } @else {
            <button class="action-btn primary" (click)="startSession.emit()">
              Start Session
            </button>
          }
        </div>
      </div>

      <!-- Toast Notifications Container -->
      @if (toasts().length > 0) {
        <div class="toast-container">
          @for (toast of toasts(); track toast.id) {
            <div
              class="toast"
              [class]="'toast-' + toast.type"
              (click)="dismissToast(toast.id)"
              (keydown.enter)="dismissToast(toast.id)"
              (keydown.space)="dismissToast(toast.id)"
              tabindex="0"
              role="button"
            >
              <span class="toast-icon">
                @switch (toast.type) {
                  @case ('success') {
                    ✓
                  }
                  @case ('error') {
                    ✗
                  }
                  @case ('info') {
                    ℹ
                  }
                }
              </span>
              <span class="toast-message">{{ toast.message }}</span>
              <button
                class="toast-close"
                (click)="dismissToast(toast.id); $event.stopPropagation()"
              >
                ✕
              </button>
            </div>
          }
        </div>
      }

      @if (store(); as storeData) {
        <!-- Stats Overview -->
        <app-context-stats [store]="storeData" />

        <!-- Session Stats (if active) -->
        @if (session(); as sessionData) {
          <app-context-session-stats [session]="sessionData" />
        }

        <!-- Query Panel -->
        <app-context-query-panel
          [hasSession]="!!session()"
          [isQuerying]="isQuerying()"
          [queryError]="queryError()"
          [savedTemplates]="savedTemplates()"
          (executeQueryRequest)="onExecuteQuery($event)"
          (saveTemplateRequest)="onSaveTemplate($event)"
          (loadTemplateRequest)="onLoadTemplate($event)"
          (deleteTemplate)="onDeleteTemplate($event)"
          (clearError)="queryError.set(null)"
        />

        <!-- Query Results Section -->
        @if (queryResults().length > 0) {
          <app-context-query-results
            [results]="queryResults()"
            [activeResult]="activeQueryResult()"
            [activeResultId]="activeQueryResult()?.id ?? null"
            (selectResult)="selectResult($event)"
            (clearResults)="clearResults()"
            (closeDetail)="activeQueryResult.set(null)"
            (copyToClipboard)="copyToClipboard($event)"
            (showSections)="showResultSections($event)"
          />
        }

        <!-- Sections Panel -->
        <app-context-sections-panel
          [sections]="storeData.sections"
          [selectedSectionId]="selectedSection()?.id ?? null"
          (selectSection)="selectSection($event)"
        />

        <!-- Section Detail -->
        @if (selectedSection(); as section) {
          <app-context-section-detail
            [section]="section"
            [selectedQueryType]="currentQueryType()"
            [sectionInQuery]="isSectionInQuery(section.id)"
            (closePanel)="clearSelection()"
            (navigateToSection)="navigateToSection($event)"
            (addToQuery)="addSectionToQuery($event)"
            (getSectionContent)="getSectionContent($event)"
          />
        }
      } @else {
        <!-- No Store State -->
        <div class="no-store">
          <span class="no-store-icon">🧩</span>
          <span class="no-store-title">No Context Store</span>
          <span class="no-store-text">
            Create a context store to start managing RLM context
          </span>
          <button class="action-btn primary" (click)="createStore.emit()">
            Create Store
          </button>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .rlm-container {
        position: relative;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        max-height: none;
        overflow: hidden;
        width: 100%;
      }

      .rlm-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .rlm-icon {
        font-size: 18px;
      }

      .rlm-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .section-count {
        padding: 2px 6px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        font-size: 11px;
        color: var(--text-secondary);
      }

      .session-badge {
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        font-size: 11px;
        font-weight: 600;

        &.active {
          background: rgba(16, 185, 129, 0.2);
          color: #10b981;
        }
      }

      .action-btn {
        padding: 6px 12px;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: 12px;
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover:not(:disabled) {
          background: var(--bg-hover);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        &.primary {
          background: var(--primary-color);
          border-color: var(--primary-color);
          color: white;

          &:hover:not(:disabled) {
            opacity: 0.9;
          }
        }
      }

      /* No Store State */
      .no-store {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--spacing-md);
        padding: var(--spacing-xl) var(--spacing-lg);
      }

      .no-store-icon {
        font-size: 48px;
        opacity: 0.5;
      }

      .no-store-title {
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .no-store-text {
        font-size: 13px;
        color: var(--text-muted);
        text-align: center;
      }

      /* Toast Notifications */
      .toast-container {
        position: absolute;
        top: 60px;
        right: var(--spacing-md);
        z-index: 1000;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        max-width: 300px;
      }

      .toast {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-sm);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        animation: slideIn 0.3s ease;
        cursor: pointer;
      }

      @keyframes slideIn {
        from {
          opacity: 0;
          transform: translateX(20px);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }

      .toast-success {
        background: rgba(16, 185, 129, 0.95);
        color: white;
      }

      .toast-error {
        background: rgba(239, 68, 68, 0.95);
        color: white;
      }

      .toast-info {
        background: rgba(59, 130, 246, 0.95);
        color: white;
      }

      .toast-icon {
        font-weight: bold;
        font-size: 14px;
      }

      .toast-message {
        flex: 1;
        font-size: 12px;
      }

      .toast-close {
        background: transparent;
        border: none;
        color: inherit;
        opacity: 0.7;
        cursor: pointer;
        font-size: 12px;

        &:hover {
          opacity: 1;
        }
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class RlmContextBrowserComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(ElectronIpcService);
  private readonly clipboard = inject(CLIPBOARD_SERVICE);
  private subscriptions: (() => void)[] = [];
  private readonly TEMPLATES_STORAGE_KEY = 'rlm-query-templates';

  /** Context store */
  store = input<ContextStore | null>(null);

  /** Active session */
  session = input<RLMSession | null>(null);

  /** Events */
  createStore = output<void>();
  startSession = output<void>();
  executeQueryRequest = output<ContextQuery>();
  sectionSelected = output<ContextSection>();
  queryExecuted = output<QueryResult>();
  storeUpdated = output<ContextStore>();

  /** Query results state */
  readonly queryResults = signal<QueryResult[]>([]);
  readonly activeQueryResult = signal<QueryResult | null>(null);
  readonly isQuerying = signal<boolean>(false);
  readonly queryError = signal<string | null>(null);
  readonly currentQueryType = signal<QueryType>('grep');

  /** Toast notification state */
  readonly toasts = signal<ToastNotification[]>([]);

  /** Saved templates state */
  readonly savedTemplates = signal<SavedQueryTemplate[]>([]);

  /** Section selection state */
  readonly selectedSection = signal<ContextSection | null>(null);
  readonly querySectionIds = signal<string[]>([]);

  ngOnInit(): void {
    this.setupEventSubscriptions();
    this.loadSavedTemplates();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((unsub) => unsub());
    this.subscriptions = [];
  }

  // ============================================
  // IPC Event Subscriptions
  // ============================================

  private setupEventSubscriptions(): void {
    const unsubStoreUpdate = this.ipc.getApi()?.onRlmStoreUpdated(
      (data: unknown) => {
        const update = data as { storeId: string; store: ContextStore };
        const currentStore = this.store();
        if (currentStore && update.storeId === currentStore.id) {
          this.storeUpdated.emit(update.store);
          this.showToast('Store updated', 'info');
        }
      }
    ) ?? (() => { /* noop */ });
    this.subscriptions.push(unsubStoreUpdate);

    const unsubSectionAdded = this.ipc.getApi()?.onRlmSectionAdded(
      (data: unknown) => {
        const update = data as { storeId: string; section: ContextSection };
        const currentStore = this.store();
        if (currentStore && update.storeId === currentStore.id) {
          this.showToast(`Section "${update.section.name}" added`, 'success');
        }
      }
    ) ?? (() => { /* noop */ });
    this.subscriptions.push(unsubSectionAdded);

    const unsubSectionRemoved = this.ipc.getApi()?.onRlmSectionRemoved(
      (data: unknown) => {
        const update = data as { storeId: string; sectionId: string };
        const currentStore = this.store();
        if (currentStore && update.storeId === currentStore.id) {
          this.showToast('Section removed', 'info');
        }
      }
    ) ?? (() => { /* noop */ });
    this.subscriptions.push(unsubSectionRemoved);

    const unsubQueryComplete = this.ipc.getApi()?.onRlmQueryComplete(
      (data: unknown) => {
        const result = data as { sessionId: string; queryResult: QueryResult };
        const currentSession = this.session();
        if (currentSession && result.sessionId === currentSession.id) {
          this.addQueryResult(result.queryResult);
        }
      }
    ) ?? (() => { /* noop */ });
    this.subscriptions.push(unsubQueryComplete);
  }

  // ============================================
  // Toast Notifications
  // ============================================

  showToast(message: string, type: ToastNotification['type'] = 'info'): void {
    const toast: ToastNotification = {
      id: `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      message,
      type,
      timestamp: Date.now()
    };

    this.toasts.update((toasts) => [...toasts, toast]);

    setTimeout(() => {
      this.dismissToast(toast.id);
    }, 3000);
  }

  dismissToast(toastId: string): void {
    this.toasts.update((toasts) => toasts.filter((t) => t.id !== toastId));
  }

  // ============================================
  // Query Management
  // ============================================

  onExecuteQuery(query: ContextQuery): void {
    this.isQuerying.set(true);
    this.queryError.set(null);
    this.currentQueryType.set(query.type);
    this.executeQueryRequest.emit(query);
  }

  addQueryResult(result: QueryResult): void {
    this.isQuerying.set(false);

    if (result.error) {
      this.queryError.set(result.error);
    }

    this.queryResults.update((results) => [result, ...results].slice(0, 50));
    this.activeQueryResult.set(result);
    this.queryExecuted.emit(result);
  }

  selectResult(result: QueryResult): void {
    this.activeQueryResult.set(result);
  }

  clearResults(): void {
    this.queryResults.set([]);
    this.activeQueryResult.set(null);
  }

  async copyToClipboard(content: string): Promise<void> {
    const result = await this.clipboard.copyText(content, { label: 'context' });
    if (result.ok) {
      this.showToast('Copied to clipboard', 'success');
    } else {
      console.error('Failed to copy to clipboard:', result.reason, result.cause);
      this.showToast('Failed to copy to clipboard', 'error');
    }
  }

  showResultSections(result: QueryResult): void {
    if (result.sections.length > 0) {
      this.navigateToSection(result.sections[0]);
    }
  }

  // ============================================
  // Section Management
  // ============================================

  selectSection(section: ContextSection): void {
    this.selectedSection.set(section);
    this.sectionSelected.emit(section);
  }

  clearSelection(): void {
    this.selectedSection.set(null);
  }

  navigateToSection(id: string): void {
    const storeData = this.store();
    if (storeData) {
      const section = storeData.sections.find((s) => s.id === id);
      if (section) {
        this.selectSection(section);
      }
    }
  }

  addSectionToQuery(id: string): void {
    this.querySectionIds.update((ids) => {
      if (!ids.includes(id)) {
        return [...ids, id];
      }
      return ids;
    });
  }

  isSectionInQuery(id: string): boolean {
    return this.querySectionIds().includes(id);
  }

  getSectionContent(sectionId: string): void {
    this.executeQueryRequest.emit({
      type: 'get_section',
      params: { sectionId }
    });
  }

  // ============================================
  // Template Management
  // ============================================

  private loadSavedTemplates(): void {
    try {
      const stored = localStorage.getItem(this.TEMPLATES_STORAGE_KEY);
      if (stored) {
        const templates = JSON.parse(stored) as SavedQueryTemplate[];
        this.savedTemplates.set(templates);
      }
    } catch (error) {
      console.error('Failed to load saved templates:', error);
    }
  }

  private persistTemplates(): void {
    try {
      localStorage.setItem(
        this.TEMPLATES_STORAGE_KEY,
        JSON.stringify(this.savedTemplates())
      );
    } catch (error) {
      console.error('Failed to save templates:', error);
    }
  }

  onSaveTemplate(template: { name: string; type: string; params: Record<string, unknown> }): void {
    const newTemplate: SavedQueryTemplate = {
      id: `template-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: template.name,
      type: template.type as QueryType,
      params: template.params,
      createdAt: Date.now()
    };

    this.savedTemplates.update((templates) => [...templates, newTemplate]);
    this.persistTemplates();
    this.showToast(`Template "${template.name}" saved`, 'success');
  }

  onLoadTemplate(template: SavedQueryTemplate): void {
    this.showToast(`Loaded template "${template.name}"`, 'info');
  }

  onDeleteTemplate(templateId: string): void {
    const template = this.savedTemplates().find((t) => t.id === templateId);
    this.savedTemplates.update((templates) =>
      templates.filter((t) => t.id !== templateId)
    );
    this.persistTemplates();
    if (template) {
      this.showToast(`Template "${template.name}" deleted`, 'info');
    }
  }

  // ============================================
  // Keyboard Navigation
  // ============================================

  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      return;
    }

    if (event.key === 'Escape') {
      if (this.activeQueryResult()) {
        this.activeQueryResult.set(null);
        event.preventDefault();
        return;
      }
      if (this.selectedSection()) {
        this.selectedSection.set(null);
        event.preventDefault();
        return;
      }
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const results = this.queryResults();
      if (results.length === 0) return;

      const currentIndex = this.activeQueryResult()
        ? results.findIndex((r) => r.id === this.activeQueryResult()!.id)
        : -1;

      const direction = event.key === 'ArrowUp' ? -1 : 1;
      const newIndex = Math.max(
        0,
        Math.min(results.length - 1, currentIndex + direction)
      );

      if (newIndex !== currentIndex) {
        this.activeQueryResult.set(results[newIndex]);
        event.preventDefault();
      }
    }
  }
}
