/**
 * Semantic Search Page
 * Natural language search using vector embeddings and Exa integration.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SearchIpcService } from '../../core/services/ipc/search-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface SearchResult {
  filePath: string;
  content: string;
  score: number;
  startLine?: number;
  endLine?: number;
  metadata?: Record<string, unknown>;
}

interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  indexSize: string;
  lastUpdated?: number;
}

@Component({
  selector: 'app-semantic-search-page',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-header">
        <div class="header-title">
          <span class="title">Semantic Search</span>
          <span class="subtitle">Natural language search with vector embeddings and Exa integration</span>
        </div>
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <div class="search-bar">
        <input
          class="query-input"
          type="text"
          [value]="query()"
          placeholder="Describe what you are looking for..."
          (input)="onQueryInput($event)"
          (keydown.enter)="search()"
        />

        <label class="field-inline">
          <span class="field-label">Limit</span>
          <select class="select" [value]="limit()" (change)="onLimitChange($event)">
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
          </select>
        </label>

        <label class="field-inline threshold-field">
          <span class="field-label">Threshold {{ thresholdDisplay() }}</span>
          <input
            class="range"
            type="range"
            min="0"
            max="1"
            step="0.05"
            [value]="threshold()"
            (input)="onThresholdInput($event)"
          />
        </label>

        <input
          class="pattern-input"
          type="text"
          [value]="filePattern()"
          placeholder="File pattern (e.g. *.ts)"
          (input)="onFilePatternInput($event)"
        />

        <button
          class="btn primary"
          type="button"
          [disabled]="busy() || !canSearch()"
          (click)="search()"
        >
          {{ busy() ? 'Searching...' : 'Search' }}
        </button>
      </div>

      <div class="content">
        <!-- Results -->
        <div class="results-panel">
          @if (results().length === 0 && !busy()) {
            <div class="empty-state">
              @if (hasSearched()) {
                <span>No results found. Try a different query or lower the threshold.</span>
              } @else {
                <span>Enter a query above to search the indexed codebase.</span>
              }
            </div>
          }

          @for (result of results(); track result.filePath + result.startLine) {
            <div
              class="result-card"
              [class.expanded]="expandedIndex() === $index"
              role="button"
              tabindex="0"
              (click)="toggleExpanded($index)"
              (keydown.enter)="toggleExpanded($index)"
            >
              <div class="result-header">
                <span class="result-path">{{ result.filePath }}</span>
                <div class="result-meta">
                  @if (result.startLine !== undefined) {
                    <span class="result-lines">
                      L{{ result.startLine }}{{ result.endLine !== undefined ? '–' + result.endLine : '' }}
                    </span>
                  }
                  <span class="result-score">{{ formatScore(result.score) }}</span>
                </div>
              </div>

              <div class="score-bar-track">
                <div class="score-bar-fill" [style.width.%]="result.score * 100"></div>
              </div>

              <pre class="result-snippet">{{ expandedIndex() === $index ? result.content : truncate(result.content, 200) }}</pre>

              @if (expandedIndex() !== $index && result.content.length > 200) {
                <span class="expand-hint">Click to expand</span>
              }
            </div>
          }
        </div>

        <!-- Sidebar -->
        <div class="sidebar">
          <!-- Index Stats -->
          <div class="panel-card">
            <div class="panel-title">Index Stats</div>

            @if (indexStats()) {
              <div class="stats-grid">
                <div class="stat-item">
                  <span class="stat-label">Files</span>
                  <span class="stat-value">{{ indexStats()!.totalFiles }}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">Chunks</span>
                  <span class="stat-value">{{ indexStats()!.totalChunks }}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">Size</span>
                  <span class="stat-value">{{ indexStats()!.indexSize }}</span>
                </div>
                @if (indexStats()!.lastUpdated) {
                  <div class="stat-item stat-full">
                    <span class="stat-label">Last Updated</span>
                    <span class="stat-value">{{ formatDate(indexStats()!.lastUpdated!) }}</span>
                  </div>
                }
              </div>
            } @else {
              <div class="hint">No index stats available.</div>
            }

            <button
              class="btn"
              type="button"
              [disabled]="busy()"
              (click)="loadStats()"
            >
              Refresh Stats
            </button>
          </div>

          <!-- Index Management -->
          <div class="panel-card">
            <div class="panel-title">Index Management</div>

            <label class="field">
              <span class="field-label">Directory</span>
              <input
                class="input"
                type="text"
                [value]="indexDirectory()"
                placeholder="/path/to/project"
                (input)="onIndexDirectoryInput($event)"
              />
            </label>

            <button
              class="btn primary"
              type="button"
              [disabled]="busy() || !canBuildIndex()"
              (click)="buildIndex()"
            >
              {{ buildingIndex() ? 'Building...' : 'Build Index' }}
            </button>
          </div>

          <!-- Exa Configuration -->
          <div class="panel-card">
            <div class="panel-title">Exa Configuration</div>

            <label class="field">
              <span class="field-label">API Key</span>
              <input
                class="input"
                type="password"
                [value]="exaApiKey()"
                placeholder="exa_..."
                (input)="onExaApiKeyInput($event)"
              />
            </label>

            <label class="checkbox-row">
              <input
                type="checkbox"
                [checked]="exaEnabled()"
                (change)="onExaEnabledChange($event)"
              />
              Enable Exa search
            </label>

            <button
              class="btn"
              type="button"
              [disabled]="busy()"
              (click)="saveExaConfig()"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
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
      overflow: hidden;
    }

    /* Header */
    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      flex-shrink: 0;
    }

    .header-title {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
    }

    .title {
      font-size: 18px;
      font-weight: 700;
    }

    .subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }

    /* Banners */
    .error-banner,
    .info-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      font-size: 12px;
      flex-shrink: 0;
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

    /* Search bar */
    .search-bar {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      flex-shrink: 0;
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      flex-wrap: wrap;
    }

    .query-input {
      flex: 1;
      min-width: 200px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 13px;
    }

    .pattern-input {
      width: 160px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
    }

    .field-inline {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .threshold-field {
      min-width: 120px;
    }

    .field-label {
      font-size: 10px;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .select {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
    }

    .range {
      width: 100%;
      cursor: pointer;
    }

    /* Content layout */
    .content {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 300px;
      gap: var(--spacing-md);
    }

    /* Results panel */
    .results-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      overflow-y: auto;
      min-height: 0;
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      min-height: 120px;
      color: var(--text-muted);
      font-size: 13px;
      border: 1px dashed var(--border-color);
      border-radius: var(--radius-md);
    }

    .result-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-sm) var(--spacing-md);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      transition: border-color 0.15s;
    }

    .result-card:hover {
      border-color: color-mix(in srgb, var(--primary-color) 60%, var(--border-color));
    }

    .result-card.expanded {
      border-color: var(--primary-color);
    }

    .result-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--spacing-sm);
    }

    .result-path {
      font-size: 12px;
      font-weight: 600;
      color: var(--primary-color);
      word-break: break-all;
      flex: 1;
      min-width: 0;
    }

    .result-meta {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      flex-shrink: 0;
    }

    .result-lines {
      font-size: 11px;
      color: var(--text-muted);
    }

    .result-score {
      font-size: 11px;
      font-weight: 700;
      color: var(--success-color);
    }

    .score-bar-track {
      height: 3px;
      background: var(--bg-tertiary);
      border-radius: 999px;
      overflow: hidden;
    }

    .score-bar-fill {
      height: 100%;
      background: var(--primary-color);
      border-radius: 999px;
      transition: width 0.3s ease;
    }

    .result-snippet {
      margin: 0;
      font-family: var(--font-family-mono, monospace);
      font-size: 11px;
      color: var(--text-secondary);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 300px;
      overflow: auto;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
    }

    .expand-hint {
      font-size: 10px;
      color: var(--text-muted);
      align-self: flex-end;
    }

    /* Sidebar */
    .sidebar {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      overflow-y: auto;
      min-height: 0;
    }

    .panel-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      flex-shrink: 0;
    }

    .panel-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
    }

    /* Stats grid */
    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--spacing-xs);
    }

    .stat-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
    }

    .stat-full {
      grid-column: 1 / -1;
    }

    .stat-label {
      font-size: 10px;
      color: var(--text-muted);
      font-weight: 600;
    }

    .stat-value {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }

    /* Form elements */
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
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

    .checkbox-row {
      display: inline-flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: 12px;
      color: var(--text-secondary);
      cursor: pointer;
    }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
    }

    /* Buttons */
    .btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
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

    @media (max-width: 900px) {
      .content {
        grid-template-columns: 1fr;
      }

      .page {
        overflow: auto;
      }
    }
  `],
})
export class SemanticSearchPageComponent implements OnInit {
  private readonly searchIpc = inject(SearchIpcService);

  // Search form state
  readonly query = signal('');
  readonly limit = signal(25);
  readonly threshold = signal(0.5);
  readonly filePattern = signal('');

  // Results state
  readonly results = signal<SearchResult[]>([]);
  readonly expandedIndex = signal<number | null>(null);
  readonly hasSearched = signal(false);

  // Index management state
  readonly indexDirectory = signal('');
  readonly buildingIndex = signal(false);

  // Index stats state
  readonly indexStats = signal<IndexStats | null>(null);

  // Exa config state
  readonly exaApiKey = signal('');
  readonly exaEnabled = signal(false);

  // UI state
  readonly busy = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  readonly canSearch = computed(() => this.query().trim().length > 0);
  readonly canBuildIndex = computed(() => this.indexDirectory().trim().length > 0);
  readonly thresholdDisplay = computed(() => this.threshold().toFixed(2));

  async ngOnInit(): Promise<void> {
    await this.loadStats();
  }

  async search(): Promise<void> {
    if (!this.canSearch() || this.busy()) {
      return;
    }

    this.clearMessages();
    this.busy.set(true);
    this.hasSearched.set(true);
    this.expandedIndex.set(null);

    try {
      const directory = this.indexDirectory().trim() || '.';
      const pattern = this.filePattern().trim();
      const response = await this.searchIpc.searchSemantic({
        query: this.query().trim(),
        directory,
        maxResults: this.limit(),
        minScore: this.threshold(),
        ...(pattern ? { includePatterns: [pattern] } : {}),
      });

      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Search failed.');
        this.results.set([]);
        return;
      }

      const raw = this.extractList<unknown>(response);
      const mapped = raw
        .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
        .map((item): SearchResult => ({
          filePath: String(item['filePath'] ?? item['file'] ?? ''),
          content: String(item['content'] ?? item['text'] ?? ''),
          score: typeof item['score'] === 'number' ? item['score'] : 0,
          startLine: typeof item['startLine'] === 'number' ? item['startLine'] : undefined,
          endLine: typeof item['endLine'] === 'number' ? item['endLine'] : undefined,
          metadata: typeof item['metadata'] === 'object' && item['metadata'] !== null
            ? (item['metadata'] as Record<string, unknown>)
            : undefined,
        }));

      this.results.set(mapped);

      if (mapped.length === 0) {
        this.infoMessage.set('No results matched the query with the current threshold.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async buildIndex(): Promise<void> {
    if (!this.canBuildIndex() || this.busy()) {
      return;
    }

    this.clearMessages();
    this.busy.set(true);
    this.buildingIndex.set(true);

    try {
      const response = await this.searchIpc.searchBuildIndex(this.indexDirectory().trim());
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to build index.');
        return;
      }
      this.infoMessage.set('Index built successfully.');
      await this.loadStats();
    } finally {
      this.busy.set(false);
      this.buildingIndex.set(false);
    }
  }

  async saveExaConfig(): Promise<void> {
    if (this.busy()) {
      return;
    }

    this.clearMessages();
    this.busy.set(true);

    try {
      const apiKey = this.exaApiKey().trim();
      const response = await this.searchIpc.searchConfigureExa({
        apiKey,
        ...(apiKey ? {} : {}),
      });

      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to save Exa config.');
        return;
      }
      this.infoMessage.set('Exa configuration saved.');
    } finally {
      this.busy.set(false);
    }
  }

  async loadStats(): Promise<void> {
    const response = await this.searchIpc.searchGetIndexStats();
    if (!response.success || !response.data) {
      return;
    }

    const data = response.data as Record<string, unknown>;
    this.indexStats.set({
      totalFiles: typeof data['totalFiles'] === 'number' ? data['totalFiles'] : 0,
      totalChunks: typeof data['totalChunks'] === 'number' ? data['totalChunks'] : 0,
      indexSize: typeof data['indexSize'] === 'string' ? data['indexSize'] : '0 B',
      lastUpdated: typeof data['lastUpdated'] === 'number' ? data['lastUpdated'] : undefined,
    });
  }

  toggleExpanded(index: number): void {
    this.expandedIndex.set(this.expandedIndex() === index ? null : index);
  }

  onQueryInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.query.set(target.value);
  }

  onLimitChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.limit.set(Number(target.value));
  }

  onThresholdInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.threshold.set(Number(target.value));
  }

  onFilePatternInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.filePattern.set(target.value);
  }

  onIndexDirectoryInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.indexDirectory.set(target.value);
  }

  onExaApiKeyInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.exaApiKey.set(target.value);
  }

  onExaEnabledChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.exaEnabled.set(target.checked);
  }

  formatScore(score: number): string {
    return (score * 100).toFixed(1) + '%';
  }

  formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) {
      return text;
    }
    return text.slice(0, maxLen) + '...';
  }

  private clearMessages(): void {
    this.errorMessage.set(null);
    this.infoMessage.set(null);
  }

  private extractList<T>(response: IpcResponse): T[] {
    if (!response.success || response.data === undefined || response.data === null) {
      return [];
    }
    if (Array.isArray(response.data)) {
      return response.data as T[];
    }
    const data = response.data as Record<string, unknown>;
    const candidate = data['results'] ?? data['items'] ?? data['data'];
    if (Array.isArray(candidate)) {
      return candidate as T[];
    }
    return [];
  }
}
