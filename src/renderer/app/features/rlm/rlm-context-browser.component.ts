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
} from '@angular/core';
import { SlicePipe } from '@angular/common';
import type {
  ContextStore,
  ContextSection,
  ContextQuery,
  QueryType,
  RLMSession,
  RLMStoreStats,
  RLMSessionStats,
} from '../../../../shared/types/rlm.types';

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
            <span class="section-count">{{ store()!.sections.length }} sections</span>
          }
        </div>
        <div class="header-actions">
          @if (session()) {
            <div class="session-badge active">
              Session Active
            </div>
          } @else {
            <button class="action-btn primary" (click)="startSession.emit()">
              Start Session
            </button>
          }
        </div>
      </div>

      @if (store(); as storeData) {
        <!-- Stats Overview -->
        <div class="stats-overview">
          <div class="stat-card">
            <span class="stat-label">Total Tokens</span>
            <span class="stat-value">{{ formatNumber(storeData.totalTokens) }}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Sections</span>
            <span class="stat-value">{{ storeData.sections.length }}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Size</span>
            <span class="stat-value">{{ formatBytes(storeData.totalSize) }}</span>
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
              <span class="session-id">{{ sessionData.id | slice:0:12 }}...</span>
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
                <span class="metric-value">{{ formatNumber(sessionData.totalRootTokens) }}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Sub-Query Tokens</span>
                <span class="metric-value">{{ formatNumber(sessionData.totalSubQueryTokens) }}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Direct Estimate</span>
                <span class="metric-value strikethrough">{{ formatNumber(sessionData.estimatedDirectTokens) }}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Queries</span>
                <span class="metric-value">{{ sessionData.queries.length }}</span>
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
                  <label class="form-label">Context Hints (comma-separated)</label>
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
                        {{ id | slice:0:8 }}...
                        <button class="remove-btn" (click)="removeSectionId(id)">✕</button>
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

            <button
              class="execute-btn"
              [disabled]="!session() || !canExecuteQuery()"
              (click)="executeQuery()"
            >
              Execute Query
            </button>
          </div>
        </div>

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
                  <span class="section-tokens">{{ section.tokens }} tokens</span>
                </div>
                <div class="section-name">{{ section.name }}</div>
                <div class="section-preview">
                  {{ truncateContent(section.content) }}
                </div>
                <div class="section-meta">
                  @if (section.filePath) {
                    <span class="meta-item">📁 {{ section.filePath | slice:-30 }}</span>
                  }
                  @if (section.depth > 0) {
                    <span class="meta-item depth">Depth: {{ section.depth }}</span>
                  }
                  @if (section.summarizes && section.summarizes.length > 0) {
                    <span class="meta-item">📚 Summarizes {{ section.summarizes.length }} sections</span>
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
                    <span class="metadata-value">{{ section.startOffset }} - {{ section.endOffset }}</span>
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
                    <span class="metadata-value mono">{{ section.checksum }}</span>
                  </div>
                </div>
              </div>

              @if (section.summarizes && section.summarizes.length > 0) {
                <div class="detail-section">
                  <span class="section-label">Summarizes</span>
                  <div class="summarizes-list">
                    @for (id of section.summarizes; track id) {
                      <button class="summarized-item" (click)="navigateToSection(id)">
                        {{ id | slice:0:12 }}...
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
              <button class="action-btn" (click)="getSectionContent(section.id)">
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
  styles: [`
    .rlm-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
      max-height: 800px;
      overflow: hidden;
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
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RlmContextBrowserComponent {
  /** Context store */
  store = input<ContextStore | null>(null);

  /** Active session */
  session = input<RLMSession | null>(null);

  /** Events */
  createStore = output<void>();
  startSession = output<void>();
  executeQueryRequest = output<ContextQuery>();
  sectionSelected = output<ContextSection>();

  /** Query types */
  queryTypes: QueryType[] = ['grep', 'slice', 'sub_query', 'summarize', 'get_section', 'semantic_search'];

  /** Section types */
  sectionTypes: ContextSection['type'][] = ['file', 'conversation', 'tool_output', 'external', 'summary'];

  /** Selected query type */
  selectedQueryType = signal<QueryType>('grep');

  /** Query parameters */
  queryParams = signal<Record<string, unknown>>({});

  /** Computed query param accessors for template */
  sectionIds = computed(() => (this.queryParams()['sectionIds'] as string[] | undefined) || []);
  sectionId = computed(() => (this.queryParams()['sectionId'] as string | undefined) || '');
  queryText = computed(() => (this.queryParams()['query'] as string | undefined) || '');
  topK = computed(() => (this.queryParams()['topK'] as number | undefined) || 5);
  pattern = computed(() => (this.queryParams()['pattern'] as string | undefined) || '');
  maxResults = computed(() => (this.queryParams()['maxResults'] as number | undefined) || 10);
  start = computed(() => (this.queryParams()['start'] as number | undefined) || 0);
  end = computed(() => (this.queryParams()['end'] as number | undefined) || 1000);
  prompt = computed(() => (this.queryParams()['prompt'] as string | undefined) || '');
  contextHints = computed(() => (this.queryParams()['contextHints'] as string[] | undefined) || []);

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
      sections = sections.filter(s => s.type === filter);
    }

    return sections.sort((a, b) => a.startOffset - b.startOffset);
  });

  getQueryTypeIcon(type: QueryType): string {
    switch (type) {
      case 'grep': return '🔍';
      case 'slice': return '✂️';
      case 'sub_query': return '🔄';
      case 'summarize': return '📝';
      case 'get_section': return '📄';
      case 'semantic_search': return '🎯';
      default: return '❓';
    }
  }

  getSectionTypeIcon(type: ContextSection['type']): string {
    switch (type) {
      case 'file': return '📁';
      case 'conversation': return '💬';
      case 'tool_output': return '🔧';
      case 'external': return '🌐';
      case 'summary': return '📋';
      default: return '📄';
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

    this.queryParams.update(params => ({ ...params, [key]: value }));
  }

  updateContextHints(event: Event): void {
    const target = event.target as HTMLInputElement;
    const hints = target.value.split(',').map(h => h.trim()).filter(h => h);
    this.queryParams.update(params => ({ ...params, contextHints: hints }));
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
      const section = storeData.sections.find(s => s.id === id);
      if (section) {
        this.selectSection(section);
      }
    }
  }

  addSectionToQuery(id: string): void {
    this.queryParams.update(params => {
      const sectionIds = (params['sectionIds'] as string[]) || [];
      if (!sectionIds.includes(id)) {
        return { ...params, sectionIds: [...sectionIds, id] };
      }
      return params;
    });
  }

  removeSectionId(id: string): void {
    this.queryParams.update(params => {
      const sectionIds = (params['sectionIds'] as string[]) || [];
      return { ...params, sectionIds: sectionIds.filter(sid => sid !== id) };
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
    if (!this.canExecuteQuery()) return;

    const query: ContextQuery = {
      type: this.selectedQueryType(),
      params: this.queryParams(),
    };

    this.executeQueryRequest.emit(query);
  }

  getSectionContent(sectionId: string): void {
    this.executeQueryRequest.emit({
      type: 'get_section',
      params: { sectionId },
    });
  }
}
