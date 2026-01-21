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
  computed,
  ChangeDetectionStrategy,
  HostListener,
  OnInit,
  OnDestroy,
  inject
} from '@angular/core';
import { SlicePipe, JsonPipe } from '@angular/common';
import type {
  ContextStore,
  ContextSection,
  ContextQuery,
  QueryType,
  RLMSession,
  RLMStoreStats,
  RLMSessionStats
} from '../../../../shared/types/rlm.types';
import { ElectronIpcService } from '../../core/services/electron-ipc.service';

/** Query result interface */
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

/** Saved query template interface */
interface SavedQueryTemplate {
  id: string;
  name: string;
  type: QueryType;
  params: Record<string, unknown>;
  createdAt: number;
}

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
  imports: [SlicePipe],
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
        <div class="stats-overview">
          <div class="stat-card">
            <span class="stat-label">Total Tokens</span>
            <span class="stat-value">{{
              formatNumber(storeData.totalTokens)
            }}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Sections</span>
            <span class="stat-value">{{ storeData.sections.length }}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Size</span>
            <span class="stat-value">{{
              formatBytes(storeData.totalSize)
            }}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Access Count</span>
            <span class="stat-value">{{ storeData.accessCount }}</span>
          </div>
        </div>

        <!-- Session Stats (if active) -->
        @if (session(); as sessionData) {
          <div class="session-stats">
            <div class="session-header">
              <span class="session-title">Session Statistics</span>
              <span class="session-id"
                >{{ sessionData.id | slice: 0 : 12 }}...</span
              >
            </div>
            <div class="savings-display">
              <div class="savings-bar">
                <div
                  class="savings-fill"
                  [style.width.%]="sessionData.tokenSavingsPercent"
                ></div>
              </div>
              <span class="savings-text">
                {{ sessionData.tokenSavingsPercent.toFixed(1) }}% token savings
              </span>
            </div>
            <div class="session-metrics">
              <div class="metric">
                <span class="metric-label">Root Tokens</span>
                <span class="metric-value">{{
                  formatNumber(sessionData.totalRootTokens)
                }}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Sub-Query Tokens</span>
                <span class="metric-value">{{
                  formatNumber(sessionData.totalSubQueryTokens)
                }}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Direct Estimate</span>
                <span class="metric-value strikethrough">{{
                  formatNumber(sessionData.estimatedDirectTokens)
                }}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Queries</span>
                <span class="metric-value">{{
                  sessionData.queries.length
                }}</span>
              </div>
            </div>
          </div>
        }

        <!-- Query Panel -->
        <div class="query-panel">
          <div class="query-header">
            <span class="query-title">Query Engine</span>
            <div class="query-type-selector">
              @for (type of queryTypes; track type) {
                <button
                  class="query-type-btn"
                  [class.active]="selectedQueryType() === type"
                  (click)="selectQueryType(type)"
                  [disabled]="!session()"
                >
                  {{ getQueryTypeIcon(type) }} {{ type }}
                </button>
              }
            </div>
          </div>

          <div class="query-input-area">
            @switch (selectedQueryType()) {
              @case ('grep') {
                <div class="query-form">
                  <label class="form-label">Pattern (regex)</label>
                  <input
                    type="text"
                    class="query-input"
                    placeholder="Search pattern..."
                    [value]="pattern()"
                    (input)="updateQueryParam('pattern', $event)"
                    [disabled]="!session()"
                  />
                  <label class="form-label">Max Results</label>
                  <input
                    type="number"
                    class="query-input small"
                    [value]="maxResults()"
                    (input)="updateQueryParam('maxResults', $event)"
                    [disabled]="!session()"
                  />
                </div>
              }
              @case ('slice') {
                <div class="query-form">
                  <label class="form-label">Start Offset</label>
                  <input
                    type="number"
                    class="query-input"
                    [value]="start()"
                    (input)="updateQueryParam('start', $event)"
                    [disabled]="!session()"
                  />
                  <label class="form-label">End Offset</label>
                  <input
                    type="number"
                    class="query-input"
                    [value]="end()"
                    (input)="updateQueryParam('end', $event)"
                    [disabled]="!session()"
                  />
                </div>
              }
              @case ('sub_query') {
                <div class="query-form">
                  <label class="form-label">Prompt</label>
                  <textarea
                    class="query-textarea"
                    placeholder="Enter your sub-query prompt..."
                    [value]="prompt()"
                    (input)="updateQueryParam('prompt', $event)"
                    [disabled]="!session()"
                  ></textarea>
                  <label class="form-label"
                    >Context Hints (comma-separated)</label
                  >
                  <input
                    type="text"
                    class="query-input"
                    placeholder="keyword1, keyword2..."
                    [value]="contextHints().join(', ')"
                    (input)="updateContextHints($event)"
                    [disabled]="!session()"
                  />
                </div>
              }
              @case ('summarize') {
                <div class="query-form">
                  <label class="form-label">Section IDs (select below)</label>
                  <div class="selected-sections">
                    @for (id of sectionIds(); track id) {
                      <span class="selected-section">
                        {{ id | slice: 0 : 8 }}...
                        <button
                          class="remove-btn"
                          (click)="removeSectionId(id)"
                        >
                          ✕
                        </button>
                      </span>
                    }
                    @if (sectionIds().length === 0) {
                      <span class="no-selection"
                        >Click sections below to select</span
                      >
                    }
                  </div>
                </div>
              }
              @case ('get_section') {
                <div class="query-form">
                  <label class="form-label">Section ID</label>
                  <input
                    type="text"
                    class="query-input"
                    placeholder="sec-..."
                    [value]="sectionId()"
                    (input)="updateQueryParam('sectionId', $event)"
                    [disabled]="!session()"
                  />
                </div>
              }
              @case ('semantic_search') {
                <div class="query-form">
                  <label class="form-label">Search Query</label>
                  <input
                    type="text"
                    class="query-input"
                    placeholder="Natural language search..."
                    [value]="queryText()"
                    (input)="updateQueryParam('query', $event)"
                    [disabled]="!session()"
                  />
                  <label class="form-label">Top K Results</label>
                  <input
                    type="number"
                    class="query-input small"
                    [value]="topK()"
                    (input)="updateQueryParam('topK', $event)"
                    [disabled]="!session()"
                  />
                </div>
              }
            }

            <div class="query-actions">
              <button
                class="execute-btn"
                [disabled]="!session() || !canExecuteQuery() || isQuerying()"
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
                  💾
                </button>
              }
            </div>
          </div>

          <!-- Saved Templates Section -->
          @if (savedTemplates().length > 0) {
            <div class="saved-templates">
              <div class="templates-header">
                <span class="templates-title">📑 Saved Templates</span>
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
                      <div
                        class="template-info"
                        (click)="loadTemplate(template)"
                      >
                        <span class="template-type">{{
                          getQueryTypeIcon(template.type)
                        }}</span>
                        <span class="template-name">{{ template.name }}</span>
                      </div>
                      <button
                        class="template-delete"
                        (click)="deleteTemplate(template.id)"
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
                <label class="form-label">Template Name</label>
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
                    >{{ getQueryTypeIcon(selectedQueryType()) }}
                    {{ selectedQueryType() }}</span
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
              <span class="error-icon">⚠️</span>
              <span class="error-text">{{ queryError() }}</span>
              <button class="close-error-btn" (click)="queryError.set(null)">
                ✕
              </button>
            </div>
          }
        </div>

        <!-- Query Results Section -->
        @if (queryResults().length > 0) {
          <div class="query-results-section">
            <div class="results-header">
              <span class="results-title">Query Results</span>
              <span class="results-count"
                >{{ queryResults().length }} results</span
              >
              <button class="clear-results-btn" (click)="clearResults()">
                Clear
              </button>
            </div>
            <div class="results-list">
              @for (result of queryResults(); track result.id) {
                <div
                  class="result-item"
                  [class.active]="activeQueryResult()?.id === result.id"
                  [class.error]="result.error"
                  (click)="selectResult(result)"
                >
                  <div class="result-header">
                    <span class="result-type"
                      >{{ getQueryTypeIcon(result.type) }}
                      {{ result.type }}</span
                    >
                    <span class="result-time">{{
                      formatRelativeTime(result.timestamp)
                    }}</span>
                  </div>
                  <div class="result-preview">
                    {{ truncateContent(result.error || result.content) }}
                  </div>
                  <div class="result-meta">
                    <span class="result-tokens"
                      >{{ result.tokens }} tokens</span
                    >
                    <span class="result-duration">{{ result.duration }}ms</span>
                    @if (result.sections.length > 0) {
                      <span class="result-sections"
                        >{{ result.sections.length }} sections</span
                      >
                    }
                  </div>
                </div>
              }
            </div>
          </div>
        }

        <!-- Active Result Detail Panel -->
        @if (activeQueryResult(); as result) {
          <div class="result-detail-panel">
            <div class="detail-header">
              <span class="detail-title">
                {{ getQueryTypeIcon(result.type) }} {{ result.type }} Result
              </span>
              <button class="close-btn" (click)="activeQueryResult.set(null)">
                ✕
              </button>
            </div>
            <div class="detail-content">
              @if (result.error) {
                <div class="error-display">
                  <span class="error-icon-large">⚠️</span>
                  <span class="error-message">{{ result.error }}</span>
                </div>
              } @else {
                <pre class="result-content-pre">{{ result.content }}</pre>
              }
            </div>
            <div class="detail-footer">
              <div class="result-stats">
                <span>{{ result.tokens }} tokens</span>
                <span>{{ result.duration }}ms</span>
                <span>{{ result.sections.length }} sections accessed</span>
              </div>
              <div class="result-actions">
                @if (!result.error) {
                  <button
                    class="action-btn"
                    (click)="copyToClipboard(result.content)"
                  >
                    📋 Copy
                  </button>
                }
                @if (result.sections.length > 0) {
                  <button
                    class="action-btn"
                    (click)="showResultSections(result)"
                  >
                    📄 View Sections
                  </button>
                }
              </div>
            </div>
          </div>
        }

        <!-- Sections List -->
        <div class="sections-panel">
          <div class="sections-header">
            <span class="sections-title">Context Sections</span>
            <div class="section-filters">
              <button
                class="filter-btn"
                [class.active]="sectionTypeFilter() === ''"
                (click)="setSectionTypeFilter('')"
              >
                All
              </button>
              @for (type of sectionTypes; track type) {
                <button
                  class="filter-btn"
                  [class.active]="sectionTypeFilter() === type"
                  (click)="setSectionTypeFilter(type)"
                >
                  {{ getSectionTypeIcon(type) }} {{ type }}
                </button>
              }
            </div>
          </div>

          <div class="sections-list">
            @for (section of filteredSections(); track section.id) {
              <div
                class="section-card"
                [class.selected]="selectedSection()?.id === section.id"
                [class.summary]="section.depth > 0"
                (click)="selectSection(section)"
              >
                <div class="section-header">
                  <span class="section-type" [class]="'type-' + section.type">
                    {{ getSectionTypeIcon(section.type) }} {{ section.type }}
                  </span>
                  <span class="section-tokens"
                    >{{ section.tokens }} tokens</span
                  >
                </div>
                <div class="section-name">{{ section.name }}</div>
                <div class="section-preview">
                  {{ truncateContent(section.content) }}
                </div>
                <div class="section-meta">
                  @if (section.filePath) {
                    <span class="meta-item"
                      >📁 {{ section.filePath | slice: -30 }}</span
                    >
                  }
                  @if (section.depth > 0) {
                    <span class="meta-item depth"
                      >Depth: {{ section.depth }}</span
                    >
                  }
                  @if (section.summarizes && section.summarizes.length > 0) {
                    <span class="meta-item"
                      >📚 Summarizes
                      {{ section.summarizes.length }} sections</span
                    >
                  }
                </div>
              </div>
            }

            @if (filteredSections().length === 0) {
              <div class="empty-state">
                <span class="empty-icon">🧩</span>
                <span class="empty-text">No sections in context store</span>
              </div>
            }
          </div>
        </div>

        <!-- Section Detail -->
        @if (selectedSection(); as section) {
          <div class="section-detail">
            <div class="detail-header">
              <span class="detail-type" [class]="'type-' + section.type">
                {{ getSectionTypeIcon(section.type) }} {{ section.type }}
              </span>
              <button class="close-btn" (click)="clearSelection()">✕</button>
            </div>

            <div class="detail-body">
              <div class="detail-section">
                <span class="section-label">Name</span>
                <span class="section-value">{{ section.name }}</span>
              </div>

              <div class="detail-section">
                <span class="section-label">Content</span>
                <pre class="section-content">{{ section.content }}</pre>
              </div>

              <div class="detail-section">
                <span class="section-label">Metadata</span>
                <div class="metadata-grid">
                  <div class="metadata-item">
                    <span class="metadata-label">Tokens</span>
                    <span class="metadata-value">{{ section.tokens }}</span>
                  </div>
                  <div class="metadata-item">
                    <span class="metadata-label">Offset</span>
                    <span class="metadata-value"
                      >{{ section.startOffset }} - {{ section.endOffset }}</span
                    >
                  </div>
                  @if (section.filePath) {
                    <div class="metadata-item">
                      <span class="metadata-label">File</span>
                      <span class="metadata-value">{{ section.filePath }}</span>
                    </div>
                  }
                  @if (section.language) {
                    <div class="metadata-item">
                      <span class="metadata-label">Language</span>
                      <span class="metadata-value">{{ section.language }}</span>
                    </div>
                  }
                  <div class="metadata-item">
                    <span class="metadata-label">Checksum</span>
                    <span class="metadata-value mono">{{
                      section.checksum
                    }}</span>
                  </div>
                </div>
              </div>

              @if (section.summarizes && section.summarizes.length > 0) {
                <div class="detail-section">
                  <span class="section-label">Summarizes</span>
                  <div class="summarizes-list">
                    @for (id of section.summarizes; track id) {
                      <button
                        class="summarized-item"
                        (click)="navigateToSection(id)"
                      >
                        {{ id | slice: 0 : 12 }}...
                      </button>
                    }
                  </div>
                </div>
              }
            </div>

            <div class="detail-actions">
              @if (selectedQueryType() === 'summarize') {
                <button
                  class="action-btn"
                  (click)="addSectionToQuery(section.id)"
                  [disabled]="isSectionInQuery(section.id)"
                >
                  {{ isSectionInQuery(section.id) ? 'Added' : 'Add to Query' }}
                </button>
              }
              <button
                class="action-btn"
                (click)="getSectionContent(section.id)"
              >
                Get Full Content
              </button>
            </div>
          </div>
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

      /* Stats Overview */
      .stats-overview {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
      }

      .stat-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: var(--spacing-sm);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
      }

      .stat-label {
        font-size: 10px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .stat-value {
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
      }

      /* Session Stats */
      .session-stats {
        padding: var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
        background: var(--bg-tertiary);
      }

      .session-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--spacing-sm);
      }

      .session-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .session-id {
        font-size: 10px;
        color: var(--text-muted);
        font-family: var(--font-mono);
      }

      .savings-display {
        margin-bottom: var(--spacing-sm);
      }

      .savings-bar {
        height: 8px;
        background: var(--bg-secondary);
        border-radius: 4px;
        overflow: hidden;
        margin-bottom: 4px;
      }

      .savings-fill {
        height: 100%;
        background: linear-gradient(90deg, #10b981, #34d399);
        border-radius: 4px;
        transition: width var(--transition-normal);
      }

      .savings-text {
        font-size: 11px;
        color: #10b981;
        font-weight: 600;
      }

      .session-metrics {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--spacing-sm);
      }

      .metric {
        display: flex;
        flex-direction: column;
      }

      .metric-label {
        font-size: 9px;
        color: var(--text-muted);
      }

      .metric-value {
        font-size: 12px;
        font-weight: 500;
        color: var(--text-primary);

        &.strikethrough {
          text-decoration: line-through;
          color: var(--text-muted);
        }
      }

      /* Query Panel */
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

      /* Sections Panel */
      .sections-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .sections-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
      }

      .sections-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .section-filters {
        display: flex;
        gap: 4px;
      }

      .filter-btn {
        padding: 3px 8px;
        background: var(--bg-tertiary);
        border: none;
        border-radius: var(--radius-sm);
        color: var(--text-secondary);
        font-size: 10px;
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          background: var(--bg-hover);
        }

        &.active {
          background: var(--primary-color);
          color: white;
        }
      }

      .sections-list {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-sm);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .section-card {
        background: var(--bg-tertiary);
        border: 1px solid transparent;
        border-radius: var(--radius-sm);
        padding: var(--spacing-sm);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          border-color: var(--border-color);
        }

        &.selected {
          border-color: var(--primary-color);
          background: var(--bg-secondary);
        }

        &.summary {
          border-left: 3px solid #f59e0b;
        }
      }

      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
      }

      .section-type {
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        font-size: 10px;
        font-weight: 600;

        &.type-file {
          background: rgba(59, 130, 246, 0.2);
          color: #3b82f6;
        }

        &.type-conversation {
          background: rgba(16, 185, 129, 0.2);
          color: #10b981;
        }

        &.type-tool_output {
          background: rgba(245, 158, 11, 0.2);
          color: #f59e0b;
        }

        &.type-external {
          background: rgba(139, 92, 246, 0.2);
          color: #8b5cf6;
        }

        &.type-summary {
          background: rgba(236, 72, 153, 0.2);
          color: #ec4899;
        }
      }

      .section-tokens {
        font-size: 10px;
        color: var(--text-muted);
      }

      .section-name {
        font-size: 12px;
        font-weight: 500;
        color: var(--text-primary);
        margin-bottom: 4px;
      }

      .section-preview {
        font-size: 11px;
        color: var(--text-secondary);
        line-height: 1.4;
        margin-bottom: 4px;
      }

      .section-meta {
        display: flex;
        gap: var(--spacing-sm);
      }

      .meta-item {
        font-size: 9px;
        color: var(--text-muted);

        &.depth {
          color: #f59e0b;
        }
      }

      /* Section Detail */
      .section-detail {
        border-top: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        max-height: 300px;
        overflow-y: auto;
      }

      .detail-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
      }

      .detail-type {
        padding: 4px 8px;
        border-radius: var(--radius-sm);
        font-size: 12px;
        font-weight: 600;
      }

      .close-btn {
        background: transparent;
        border: none;
        color: var(--text-secondary);
        font-size: 16px;
        cursor: pointer;

        &:hover {
          color: var(--text-primary);
        }
      }

      .detail-body {
        padding: var(--spacing-md);
      }

      .detail-section {
        margin-bottom: var(--spacing-md);

        &:last-child {
          margin-bottom: 0;
        }
      }

      .section-label {
        display: block;
        font-size: 10px;
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: var(--spacing-xs);
      }

      .section-value {
        font-size: 12px;
        color: var(--text-primary);
      }

      .section-content {
        margin: 0;
        padding: var(--spacing-sm);
        background: var(--bg-secondary);
        border-radius: var(--radius-sm);
        font-size: 11px;
        color: var(--text-primary);
        white-space: pre-wrap;
        max-height: 120px;
        overflow-y: auto;
        font-family: var(--font-mono);
      }

      .metadata-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--spacing-sm);
      }

      .metadata-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .metadata-label {
        font-size: 9px;
        color: var(--text-muted);
      }

      .metadata-value {
        font-size: 11px;
        color: var(--text-primary);

        &.mono {
          font-family: var(--font-mono);
        }
      }

      .summarizes-list {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }

      .summarized-item {
        padding: 4px 8px;
        background: var(--bg-secondary);
        border: none;
        border-radius: var(--radius-sm);
        color: var(--primary-color);
        font-size: 10px;
        cursor: pointer;
        font-family: var(--font-mono);

        &:hover {
          background: var(--primary-color);
          color: white;
        }
      }

      .detail-actions {
        padding: var(--spacing-sm) var(--spacing-md);
        border-top: 1px solid var(--border-color);
        display: flex;
        gap: var(--spacing-sm);
        justify-content: flex-end;
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

      /* Empty State */
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xl);
        color: var(--text-muted);
      }

      .empty-icon {
        font-size: 32px;
        opacity: 0.5;
      }

      .empty-text {
        font-size: 13px;
      }

      /* Query Results Section */
      .query-results-section {
        border-bottom: 1px solid var(--border-color);
        background: var(--bg-tertiary);
      }

      .results-header {
        display: flex;
        align-items: center;
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
      }

      .results-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
        flex: 1;
      }

      .results-count {
        font-size: 11px;
        color: var(--text-muted);
        margin-right: var(--spacing-sm);
      }

      .clear-results-btn {
        padding: 2px 8px;
        background: var(--bg-secondary);
        border: none;
        border-radius: var(--radius-sm);
        color: var(--text-secondary);
        font-size: 10px;
        cursor: pointer;

        &:hover {
          background: var(--bg-hover);
        }
      }

      .results-list {
        max-height: 200px;
        overflow-y: auto;
      }

      .result-item {
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          background: var(--bg-hover);
        }

        &.active {
          background: var(--bg-secondary);
          border-left: 3px solid var(--primary-color);
        }

        &.error {
          background: rgba(239, 68, 68, 0.1);

          .result-type {
            color: #ef4444;
          }
        }
      }

      .result-header {
        display: flex;
        justify-content: space-between;
        margin-bottom: 4px;
      }

      .result-type {
        font-size: 11px;
        font-weight: 500;
        color: var(--text-primary);
      }

      .result-time {
        font-size: 10px;
        color: var(--text-muted);
      }

      .result-preview {
        font-size: 11px;
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 4px;
      }

      .result-meta {
        display: flex;
        gap: var(--spacing-md);
        font-size: 10px;
        color: var(--text-muted);
      }

      /* Result Detail Panel */
      .result-detail-panel {
        border-bottom: 1px solid var(--border-color);
        background: var(--bg-secondary);
        max-height: 350px;
        display: flex;
        flex-direction: column;
      }

      .detail-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
      }

      .detail-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .detail-content {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-md);
      }

      .result-content-pre {
        margin: 0;
        font-family: var(--font-mono);
        font-size: 11px;
        color: var(--text-primary);
        white-space: pre-wrap;
        line-height: 1.5;
      }

      .error-display {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        background: rgba(239, 68, 68, 0.1);
        border-radius: var(--radius-sm);
      }

      .error-icon-large {
        font-size: 24px;
      }

      .error-message {
        color: #ef4444;
        font-size: 12px;
      }

      .detail-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        border-top: 1px solid var(--border-color);
      }

      .result-stats {
        display: flex;
        gap: var(--spacing-md);
        font-size: 10px;
        color: var(--text-muted);
      }

      .result-actions {
        display: flex;
        gap: var(--spacing-sm);
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

      /* Spinner */
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

      /* Query Actions */
      .query-actions {
        display: flex;
        gap: var(--spacing-sm);
        align-items: center;
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
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class RlmContextBrowserComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(ElectronIpcService);
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

  /** Toast notification state */
  readonly toasts = signal<ToastNotification[]>([]);

  /** Saved templates state */
  readonly savedTemplates = signal<SavedQueryTemplate[]>([]);
  readonly templatesExpanded = signal<boolean>(true);
  readonly showSaveTemplateDialog = signal<boolean>(false);
  readonly newTemplateName = signal<string>('');

  /** Query types */
  queryTypes: QueryType[] = [
    'grep',
    'slice',
    'sub_query',
    'summarize',
    'get_section',
    'semantic_search'
  ];

  /** Section types */
  sectionTypes: ContextSection['type'][] = [
    'file',
    'conversation',
    'tool_output',
    'external',
    'summary'
  ];

  /** Selected query type */
  selectedQueryType = signal<QueryType>('grep');

  /** Query parameters */
  queryParams = signal<Record<string, unknown>>({});

  /** Computed query param accessors for template */
  sectionIds = computed(
    () => (this.queryParams()['sectionIds'] as string[] | undefined) || []
  );
  sectionId = computed(
    () => (this.queryParams()['sectionId'] as string | undefined) || ''
  );
  queryText = computed(
    () => (this.queryParams()['query'] as string | undefined) || ''
  );
  topK = computed(
    () => (this.queryParams()['topK'] as number | undefined) || 5
  );
  pattern = computed(
    () => (this.queryParams()['pattern'] as string | undefined) || ''
  );
  maxResults = computed(
    () => (this.queryParams()['maxResults'] as number | undefined) || 10
  );
  start = computed(
    () => (this.queryParams()['start'] as number | undefined) || 0
  );
  end = computed(
    () => (this.queryParams()['end'] as number | undefined) || 1000
  );
  prompt = computed(
    () => (this.queryParams()['prompt'] as string | undefined) || ''
  );
  contextHints = computed(
    () => (this.queryParams()['contextHints'] as string[] | undefined) || []
  );

  /** Section type filter */
  sectionTypeFilter = signal<ContextSection['type'] | ''>('');

  /** Selected section */
  selectedSection = signal<ContextSection | null>(null);

  /** Filtered sections */
  filteredSections = computed(() => {
    const storeData = this.store();
    if (!storeData) return [];

    const filter = this.sectionTypeFilter();
    let sections = storeData.sections;

    if (filter) {
      sections = sections.filter((s) => s.type === filter);
    }

    return sections.sort((a, b) => a.startOffset - b.startOffset);
  });

  // ============================================
  // Lifecycle Hooks
  // ============================================

  ngOnInit(): void {
    this.setupEventSubscriptions();
    this.loadSavedTemplates();
  }

  ngOnDestroy(): void {
    // Clean up all IPC subscriptions
    this.subscriptions.forEach((unsub) => unsub());
    this.subscriptions = [];
  }

  // ============================================
  // IPC Event Subscriptions
  // ============================================

  private setupEventSubscriptions(): void {
    // Subscribe to store updates
    const unsubStoreUpdate = this.ipc.on(
      'rlm:store-updated',
      (data: unknown) => {
        const update = data as { storeId: string; store: ContextStore };
        const currentStore = this.store();
        if (currentStore && update.storeId === currentStore.id) {
          this.storeUpdated.emit(update.store);
          this.showToast('Store updated', 'info');
        }
      }
    );
    this.subscriptions.push(unsubStoreUpdate);

    // Subscribe to section added events
    const unsubSectionAdded = this.ipc.on(
      'rlm:section-added',
      (data: unknown) => {
        const update = data as { storeId: string; section: ContextSection };
        const currentStore = this.store();
        if (currentStore && update.storeId === currentStore.id) {
          this.showToast(`Section "${update.section.name}" added`, 'success');
        }
      }
    );
    this.subscriptions.push(unsubSectionAdded);

    // Subscribe to section removed events
    const unsubSectionRemoved = this.ipc.on(
      'rlm:section-removed',
      (data: unknown) => {
        const update = data as { storeId: string; sectionId: string };
        const currentStore = this.store();
        if (currentStore && update.storeId === currentStore.id) {
          this.showToast('Section removed', 'info');
        }
      }
    );
    this.subscriptions.push(unsubSectionRemoved);

    // Subscribe to query completion events
    const unsubQueryComplete = this.ipc.on(
      'rlm:query-complete',
      (data: unknown) => {
        const result = data as { sessionId: string; queryResult: QueryResult };
        const currentSession = this.session();
        if (currentSession && result.sessionId === currentSession.id) {
          this.addQueryResult(result.queryResult);
        }
      }
    );
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

    // Auto-dismiss after 3 seconds
    setTimeout(() => {
      this.dismissToast(toast.id);
    }, 3000);
  }

  dismissToast(toastId: string): void {
    this.toasts.update((toasts) => toasts.filter((t) => t.id !== toastId));
  }

  // ============================================
  // Saved Query Templates
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

    const template: SavedQueryTemplate = {
      id: `template-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name,
      type: this.selectedQueryType(),
      params: { ...this.queryParams() },
      createdAt: Date.now()
    };

    this.savedTemplates.update((templates) => [...templates, template]);
    this.persistTemplates();
    this.closeSaveTemplateDialog();
    this.showToast(`Template "${name}" saved`, 'success');
  }

  loadTemplate(template: SavedQueryTemplate): void {
    this.selectedQueryType.set(template.type);
    this.queryParams.set({ ...template.params });
    this.showToast(`Loaded template "${template.name}"`, 'info');
  }

  deleteTemplate(templateId: string): void {
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
  // Icon & Formatting Methods
  // ============================================

  getQueryTypeIcon(type: QueryType): string {
    switch (type) {
      case 'grep':
        return '🔍';
      case 'slice':
        return '✂️';
      case 'sub_query':
        return '🔄';
      case 'summarize':
        return '📝';
      case 'get_section':
        return '📄';
      case 'semantic_search':
        return '🎯';
      default:
        return '❓';
    }
  }

  getSectionTypeIcon(type: ContextSection['type']): string {
    switch (type) {
      case 'file':
        return '📁';
      case 'conversation':
        return '💬';
      case 'tool_output':
        return '🔧';
      case 'external':
        return '🌐';
      case 'summary':
        return '📋';
      default:
        return '📄';
    }
  }

  formatNumber(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }

  formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
  }

  truncateContent(content: string): string {
    if (content.length <= 100) return content;
    return content.slice(0, 100) + '...';
  }

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

  setSectionTypeFilter(type: ContextSection['type'] | ''): void {
    this.sectionTypeFilter.set(type);
  }

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

  isSectionInQuery(id: string): boolean {
    const sectionIds = (this.queryParams()['sectionIds'] as string[]) || [];
    return sectionIds.includes(id);
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

    const queryType = this.selectedQueryType();
    const startTime = Date.now();

    this.isQuerying.set(true);
    this.queryError.set(null);

    const query: ContextQuery = {
      type: queryType,
      params: this.queryParams()
    };

    // Emit to parent for actual execution
    this.executeQueryRequest.emit(query);

    // For now, the parent component should call addQueryResult when done
    // This is a placeholder - real implementation would use IPC
  }

  /**
   * Add a query result (called by parent after execution)
   */
  addQueryResult(result: QueryResult): void {
    this.isQuerying.set(false);

    if (result.error) {
      this.queryError.set(result.error);
    }

    // Add to results list (keep last 50)
    this.queryResults.update((results) => [result, ...results].slice(0, 50));
    this.activeQueryResult.set(result);
    this.queryExecuted.emit(result);
  }

  /**
   * Select a result to view details
   */
  selectResult(result: QueryResult): void {
    this.activeQueryResult.set(result);
  }

  /**
   * Clear all results
   */
  clearResults(): void {
    this.queryResults.set([]);
    this.activeQueryResult.set(null);
  }

  /**
   * Format relative time for display
   */
  formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    if (seconds > 0) return `${seconds}s ago`;
    return 'just now';
  }

  /**
   * Copy content to clipboard
   */
  async copyToClipboard(content: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(content);
      this.showToast('Copied to clipboard', 'success');
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      this.showToast('Failed to copy to clipboard', 'error');
    }
  }

  /**
   * Show sections accessed by a result
   */
  showResultSections(result: QueryResult): void {
    // Navigate to the first section in the result
    if (result.sections.length > 0) {
      this.navigateToSection(result.sections[0]);
    }
  }

  /**
   * Keyboard navigation
   */
  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    // Ctrl/Cmd + Enter to execute query
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      if (this.canExecuteQuery() && !this.isQuerying()) {
        this.executeQuery();
      }
      event.preventDefault();
      return;
    }

    // Escape to close panels
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

    // Arrow keys to navigate results
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

  getSectionContent(sectionId: string): void {
    this.executeQueryRequest.emit({
      type: 'get_section',
      params: { sectionId }
    });
  }
}
