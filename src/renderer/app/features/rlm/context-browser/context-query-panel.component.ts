/**
 * Context Query Panel Component - Query engine with forms and templates
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy
} from '@angular/core';
import { SlicePipe } from '@angular/common';
import type { QueryType, ContextQuery } from '../../../../../shared/types/rlm.types';

export interface SavedQueryTemplate {
  id: string;
  name: string;
  type: QueryType;
  params: Record<string, unknown>;
  createdAt: number;
}

@Component({
  selector: 'app-context-query-panel',
  standalone: true,
  imports: [SlicePipe],
  template: `
    <div class="query-panel">
      <div class="query-header">
        <span class="query-title">Query Engine</span>
        <div class="query-type-selector">
          @for (type of queryTypes; track type) {
            <button
              class="query-type-btn"
              [class.active]="selectedQueryType() === type"
              (click)="selectQueryType(type)"
              [disabled]="!hasSession()"
            >
              {{ type }}
            </button>
          }
        </div>
      </div>

      <div class="query-input-area">
        @switch (selectedQueryType()) {
          @case ('grep') {
            <div class="query-form">
              <span class="form-label">Pattern (regex)</span>
              <input
                type="text"
                class="query-input"
                placeholder="Search pattern..."
                [value]="pattern()"
                (input)="updateQueryParam('pattern', $event)"
                [disabled]="!hasSession()"
              />
              <span class="form-label">Max Results</span>
              <input
                type="number"
                class="query-input small"
                [value]="maxResults()"
                (input)="updateQueryParam('maxResults', $event)"
                [disabled]="!hasSession()"
              />
            </div>
          }
          @case ('slice') {
            <div class="query-form">
              <span class="form-label">Start Offset</span>
              <input
                type="number"
                class="query-input"
                [value]="start()"
                (input)="updateQueryParam('start', $event)"
                [disabled]="!hasSession()"
              />
              <span class="form-label">End Offset</span>
              <input
                type="number"
                class="query-input"
                [value]="end()"
                (input)="updateQueryParam('end', $event)"
                [disabled]="!hasSession()"
              />
            </div>
          }
          @case ('sub_query') {
            <div class="query-form">
              <span class="form-label">Prompt</span>
              <textarea
                class="query-textarea"
                placeholder="Enter your sub-query prompt..."
                [value]="prompt()"
                (input)="updateQueryParam('prompt', $event)"
                [disabled]="!hasSession()"
              ></textarea>
              <span class="form-label">Context Hints (comma-separated)</span>
              <input
                type="text"
                class="query-input"
                placeholder="keyword1, keyword2..."
                [value]="contextHintsStr()"
                (input)="updateContextHints($event)"
                [disabled]="!hasSession()"
              />
            </div>
          }
          @case ('summarize') {
            <div class="query-form">
              <span class="form-label">Section IDs (select below)</span>
              <div class="selected-sections">
                @for (id of sectionIds(); track id) {
                  <span class="selected-section">
                    {{ id | slice: 0 : 8 }}...
                    <button class="remove-btn" (click)="removeSectionId(id)">
                      ✕
                    </button>
                  </span>
                }
                @if (sectionIds().length === 0) {
                  <span class="no-selection">Click sections below to select</span>
                }
              </div>
            </div>
          }
          @case ('get_section') {
            <div class="query-form">
              <span class="form-label">Section ID</span>
              <input
                type="text"
                class="query-input"
                placeholder="sec-..."
                [value]="sectionId()"
                (input)="updateQueryParam('sectionId', $event)"
                [disabled]="!hasSession()"
              />
            </div>
          }
          @case ('semantic_search') {
            <div class="query-form">
              <span class="form-label">Search Query</span>
              <input
                type="text"
                class="query-input"
                placeholder="Natural language search..."
                [value]="queryText()"
                (input)="updateQueryParam('query', $event)"
                [disabled]="!hasSession()"
              />
              <span class="form-label">Top K Results</span>
              <input
                type="number"
                class="query-input small"
                [value]="topK()"
                (input)="updateQueryParam('topK', $event)"
                [disabled]="!hasSession()"
              />
            </div>
          }
        }

        <div class="query-actions">
          <button
            class="execute-btn"
            [disabled]="!hasSession() || !canExecuteQuery() || isQuerying()"
            (click)="executeQuery()"
          >
            @if (isQuerying()) {
              <span class="spinner">⟳</span> Querying...
            } @else {
              Execute Query
            }
          </button>
          @if (canExecuteQuery()) {
            <button
              class="save-template-btn"
              (click)="openSaveTemplateDialog()"
              title="Save as template"
            >
              Save
            </button>
          }
        </div>
      </div>

      <!-- Saved Templates Section -->
      @if (savedTemplates().length > 0) {
        <div class="saved-templates">
          <div class="templates-header">
            <span class="templates-title">Saved Templates</span>
            <button
              class="collapse-btn"
              (click)="templatesExpanded.set(!templatesExpanded())"
            >
              {{ templatesExpanded() ? '▼' : '▶' }}
            </button>
          </div>
          @if (templatesExpanded()) {
            <div class="templates-list">
              @for (template of savedTemplates(); track template.id) {
                <div class="template-item">
                  <div class="template-info" (click)="loadTemplate(template)" (keydown.enter)="loadTemplate(template)" (keydown.space)="loadTemplate(template)" tabindex="0" role="button">
                    <span class="template-type">{{ template.type }}</span>
                    <span class="template-name">{{ template.name }}</span>
                  </div>
                  <button
                    class="template-delete"
                    (click)="deleteTemplate.emit(template.id)"
                    title="Delete template"
                  >
                    ✕
                  </button>
                </div>
              }
            </div>
          }
        </div>
      }

      <!-- Save Template Dialog -->
      @if (showSaveTemplateDialog()) {
        <div class="save-template-dialog">
          <div class="dialog-header">
            <span>Save Query Template</span>
            <button class="close-btn" (click)="closeSaveTemplateDialog()">
              ✕
            </button>
          </div>
          <div class="dialog-body">
            <span class="form-label">Template Name</span>
            <input
              type="text"
              class="query-input"
              placeholder="Enter template name..."
              [value]="newTemplateName()"
              (input)="updateTemplateName($event)"
            />
            <div class="template-preview">
              <span class="preview-label">Query Type:</span>
              <span class="preview-value"
                >{{ selectedQueryType() }}</span
              >
            </div>
          </div>
          <div class="dialog-footer">
            <button class="action-btn" (click)="closeSaveTemplateDialog()">
              Cancel
            </button>
            <button
              class="action-btn primary"
              [disabled]="!newTemplateName().trim()"
              (click)="saveTemplate()"
            >
              Save
            </button>
          </div>
        </div>
      }

      <!-- Error Banner -->
      @if (queryError()) {
        <div class="error-banner">
          <span class="error-text">{{ queryError() }}</span>
          <button class="close-error-btn" (click)="clearError.emit()">✕</button>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .query-panel {
        padding: var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
      }

      .query-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--spacing-sm);
      }

      .query-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .query-type-selector {
        display: flex;
        gap: 4px;
      }

      .query-type-btn {
        padding: 4px 8px;
        background: var(--bg-tertiary);
        border: none;
        border-radius: var(--radius-sm);
        color: var(--text-secondary);
        font-size: 10px;
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover:not(:disabled) {
          background: var(--bg-hover);
        }

        &.active {
          background: var(--primary-color);
          color: white;
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      .query-input-area {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .query-form {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .form-label {
        font-size: 10px;
        color: var(--text-muted);
        font-weight: 500;
      }

      .query-input {
        padding: 8px 12px;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: 12px;

        &:focus {
          outline: none;
          border-color: var(--primary-color);
        }

        &:disabled {
          opacity: 0.5;
        }

        &.small {
          width: 100px;
        }
      }

      .query-textarea {
        padding: 8px 12px;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: 12px;
        min-height: 60px;
        resize: vertical;

        &:focus {
          outline: none;
          border-color: var(--primary-color);
        }

        &:disabled {
          opacity: 0.5;
        }
      }

      .selected-sections {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: var(--spacing-xs);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        min-height: 32px;
      }

      .selected-section {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        background: var(--primary-color);
        color: white;
        border-radius: var(--radius-sm);
        font-size: 10px;
      }

      .remove-btn {
        background: transparent;
        border: none;
        color: white;
        cursor: pointer;
        opacity: 0.7;

        &:hover {
          opacity: 1;
        }
      }

      .no-selection {
        font-size: 11px;
        color: var(--text-muted);
      }

      .query-actions {
        display: flex;
        gap: var(--spacing-sm);
        align-items: center;
      }

      .execute-btn {
        padding: 8px 16px;
        background: var(--primary-color);
        border: none;
        border-radius: var(--radius-sm);
        color: white;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover:not(:disabled) {
          opacity: 0.9;
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      .save-template-btn {
        padding: 8px 12px;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: 14px;
        transition: all var(--transition-fast);

        &:hover {
          background: var(--bg-hover);
        }
      }

      .spinner {
        display: inline-block;
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(360deg);
        }
      }

      /* Saved Templates */
      .saved-templates {
        margin-top: var(--spacing-sm);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
      }

      .templates-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-xs) var(--spacing-sm);
        cursor: pointer;
      }

      .templates-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-secondary);
      }

      .collapse-btn {
        background: transparent;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 10px;
      }

      .templates-list {
        border-top: 1px solid var(--border-color);
        max-height: 120px;
        overflow-y: auto;
      }

      .template-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-xs) var(--spacing-sm);
        border-bottom: 1px solid var(--border-color);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:last-child {
          border-bottom: none;
        }

        &:hover {
          background: var(--bg-hover);
        }
      }

      .template-info {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        flex: 1;
      }

      .template-type {
        font-size: 12px;
      }

      .template-name {
        font-size: 11px;
        color: var(--text-primary);
      }

      .template-delete {
        background: transparent;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 10px;
        opacity: 0;
        transition: opacity var(--transition-fast);

        .template-item:hover & {
          opacity: 1;
        }

        &:hover {
          color: #ef4444;
        }
      }

      /* Save Template Dialog */
      .save-template-dialog {
        margin-top: var(--spacing-sm);
        border: 1px solid var(--primary-color);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
      }

      .dialog-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm);
        border-bottom: 1px solid var(--border-color);
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .close-btn {
        background: transparent;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 14px;

        &:hover {
          color: var(--text-primary);
        }
      }

      .dialog-body {
        padding: var(--spacing-sm);
      }

      .template-preview {
        margin-top: var(--spacing-sm);
        padding: var(--spacing-xs);
        background: var(--bg-secondary);
        border-radius: var(--radius-sm);
        font-size: 11px;
      }

      .preview-label {
        color: var(--text-muted);
      }

      .preview-value {
        color: var(--text-primary);
        margin-left: var(--spacing-xs);
      }

      .dialog-footer {
        display: flex;
        justify-content: flex-end;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        border-top: 1px solid var(--border-color);
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

      /* Error Banner */
      .error-banner {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        background: rgba(239, 68, 68, 0.1);
        border-radius: var(--radius-sm);
        margin-top: var(--spacing-sm);
      }

      .error-text {
        flex: 1;
        font-size: 12px;
        color: #ef4444;
      }

      .close-error-btn {
        background: transparent;
        border: none;
        color: #ef4444;
        cursor: pointer;
        font-size: 14px;
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ContextQueryPanelComponent {
  hasSession = input(false);
  isQuerying = input(false);
  queryError = input<string | null>(null);
  savedTemplates = input<SavedQueryTemplate[]>([]);

  executeQueryRequest = output<ContextQuery>();
  saveTemplateRequest = output<{ name: string; type: QueryType; params: Record<string, unknown> }>();
  loadTemplateRequest = output<SavedQueryTemplate>();
  deleteTemplate = output<string>();
  clearError = output<void>();

  queryTypes: QueryType[] = [
    'grep',
    'slice',
    'sub_query',
    'summarize',
    'get_section',
    'semantic_search'
  ];

  selectedQueryType = signal<QueryType>('grep');
  queryParams = signal<Record<string, unknown>>({});
  templatesExpanded = signal(true);
  showSaveTemplateDialog = signal(false);
  newTemplateName = signal('');

  // Computed param accessors
  sectionIds = computed(() => (this.queryParams()['sectionIds'] as string[]) || []);
  sectionId = computed(() => (this.queryParams()['sectionId'] as string) || '');
  queryText = computed(() => (this.queryParams()['query'] as string) || '');
  topK = computed(() => (this.queryParams()['topK'] as number) || 5);
  pattern = computed(() => (this.queryParams()['pattern'] as string) || '');
  maxResults = computed(() => (this.queryParams()['maxResults'] as number) || 10);
  start = computed(() => (this.queryParams()['start'] as number) || 0);
  end = computed(() => (this.queryParams()['end'] as number) || 1000);
  prompt = computed(() => (this.queryParams()['prompt'] as string) || '');
  contextHints = computed(() => (this.queryParams()['contextHints'] as string[]) || []);
  contextHintsStr = computed(() => this.contextHints().join(', '));

  selectQueryType(type: QueryType): void {
    this.selectedQueryType.set(type);
    this.queryParams.set({});
  }

  updateQueryParam(key: string, event: Event): void {
    const target = event.target as HTMLInputElement;
    let value: string | number = target.value;

    if (target.type === 'number') {
      value = parseInt(target.value, 10) || 0;
    }

    this.queryParams.update((params) => ({ ...params, [key]: value }));
  }

  updateContextHints(event: Event): void {
    const target = event.target as HTMLInputElement;
    const hints = target.value
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h);
    this.queryParams.update((params) => ({ ...params, contextHints: hints }));
  }

  addSectionId(id: string): void {
    this.queryParams.update((params) => {
      const sectionIds = (params['sectionIds'] as string[]) || [];
      if (!sectionIds.includes(id)) {
        return { ...params, sectionIds: [...sectionIds, id] };
      }
      return params;
    });
  }

  removeSectionId(id: string): void {
    this.queryParams.update((params) => {
      const sectionIds = (params['sectionIds'] as string[]) || [];
      return { ...params, sectionIds: sectionIds.filter((sid) => sid !== id) };
    });
  }

  canExecuteQuery(): boolean {
    const params = this.queryParams();
    const type = this.selectedQueryType();

    switch (type) {
      case 'grep':
        return !!(params['pattern'] as string)?.trim();
      case 'slice':
        return params['start'] !== undefined && params['end'] !== undefined;
      case 'sub_query':
        return !!(params['prompt'] as string)?.trim();
      case 'summarize':
        return ((params['sectionIds'] as string[]) || []).length > 0;
      case 'get_section':
        return !!(params['sectionId'] as string)?.trim();
      case 'semantic_search':
        return !!(params['query'] as string)?.trim();
      default:
        return false;
    }
  }

  executeQuery(): void {
    if (!this.canExecuteQuery() || this.isQuerying()) return;

    const query: ContextQuery = {
      type: this.selectedQueryType(),
      params: this.queryParams()
    };

    this.executeQueryRequest.emit(query);
  }

  openSaveTemplateDialog(): void {
    this.newTemplateName.set('');
    this.showSaveTemplateDialog.set(true);
  }

  closeSaveTemplateDialog(): void {
    this.showSaveTemplateDialog.set(false);
    this.newTemplateName.set('');
  }

  updateTemplateName(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.newTemplateName.set(target.value);
  }

  saveTemplate(): void {
    const name = this.newTemplateName().trim();
    if (!name) return;

    this.saveTemplateRequest.emit({
      name,
      type: this.selectedQueryType(),
      params: { ...this.queryParams() }
    });

    this.closeSaveTemplateDialog();
  }

  loadTemplate(template: SavedQueryTemplate): void {
    this.selectedQueryType.set(template.type);
    this.queryParams.set({ ...template.params });
    this.loadTemplateRequest.emit(template);
  }
}
