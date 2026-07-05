/**
 * Codebase Page Component
 *
 * Full-page wrapper for the codebase search feature:
 * - Wraps CodebasePanelComponent in a page layout
 * - Adds a symbol search sidebar with debounced input
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { CodebasePanelComponent } from './codebase-panel.component';
import { CodebaseIpcService } from '../../core/services/ipc/codebase-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface SymbolResult {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  containerName?: string;
}

const SYMBOL_KIND_ICONS: Record<string, string> = {
  function: 'f',
  method: 'f',
  class: 'C',
  interface: 'I',
  variable: 'v',
  const: 'v',
  enum: 'E',
};

@Component({
  selector: 'app-codebase-page',
  standalone: true,
  imports: [CommonModule, CodebasePanelComponent],
  template: `
    <div class="codebase-page">
      <!-- Page Header -->
      <div class="page-header">
        <div class="header-title">
          <span class="title">Codebase Search</span>
          <span class="subtitle">Semantic search, indexing, and symbol navigation</span>
        </div>
        <div class="header-actions">
          <button
            class="refresh-btn"
            type="button"
            [disabled]="refreshing()"
            (click)="refresh()"
          >
            {{ refreshing() ? 'Refreshing...' : 'Refresh' }}
          </button>
        </div>
      </div>

      <!-- 2-column layout -->
      <div class="layout">
        <!-- Left: Codebase panel -->
        <div class="main-panel">
          <app-codebase-panel
            storeId="default"
            (openFileRequest)="onOpenFile($event)"
          />
        </div>

        <!-- Right: Symbol search sidebar -->
        <div class="side-panel">
          <div class="panel-card">
            <div class="panel-title">Symbol Search</div>
            <input
              class="symbol-input"
              type="text"
              placeholder="Search functions, classes, interfaces..."
              [value]="symbolQuery()"
              (input)="onSymbolInput($event)"
            />

            @if (searchingSymbols()) {
              <div class="searching-hint">Searching...</div>
            }

            @if (!searchingSymbols() && symbolQuery().trim().length > 0 && symbolResults().length === 0) {
              <div class="no-results">No symbols found for "{{ symbolQuery() }}"</div>
            }

            @if (symbolResults().length > 0) {
              <div class="symbol-list">
                @for (symbol of symbolResults(); track symbol.filePath + ':' + symbol.line + ':' + symbol.name) {
                  <button
                    class="symbol-item"
                    type="button"
                    (click)="openSymbol(symbol)"
                  >
                    <span class="symbol-kind" [attr.data-kind]="symbol.kind">
                      {{ kindIcon(symbol.kind) }}
                    </span>
                    <span class="symbol-info">
                      <span class="symbol-name">{{ symbol.name }}</span>
                      @if (symbol.containerName) {
                        <span class="symbol-container">{{ symbol.containerName }}</span>
                      }
                      <span class="symbol-path">{{ symbol.filePath }}:{{ symbol.line }}</span>
                    </span>
                  </button>
                }
              </div>
            }

            @if (symbolResults().length === 0 && symbolQuery().trim().length === 0) {
              <div class="symbol-hint">
                Type a name to search for functions, classes, interfaces, and variables.
              </div>
            }
          </div>

          <!-- Footer stats -->
          <div class="stats-card">
            <div class="stat-item">
              <span class="stat-label">Symbol Results</span>
              <span class="stat-value">{{ symbolResultCount() }}</span>
            </div>
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

    .codebase-page {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow: hidden;
    }

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
    }

    .title {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .refresh-btn {
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 12px;

      &:hover:not(:disabled) {
        background: var(--bg-secondary);
      }

      &:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
    }

    .layout {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: var(--spacing-md);
    }

    .main-panel {
      min-height: 0;
      overflow: hidden;
    }

    .side-panel {
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      overflow: hidden;
    }

    .panel-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    .panel-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      flex-shrink: 0;
    }

    .symbol-input {
      width: 100%;
      padding: var(--spacing-sm);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 13px;
      flex-shrink: 0;

      &::placeholder {
        color: var(--text-muted);
      }

      &:focus {
        border-color: var(--primary-color);
        outline: none;
      }
    }

    .searching-hint {
      font-size: 12px;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .no-results {
      font-size: 12px;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .symbol-hint {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.5;
      flex-shrink: 0;
    }

    .symbol-list {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .symbol-item {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-sm);
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      background: var(--bg-tertiary);
      cursor: pointer;
      text-align: left;
      width: 100%;

      &:hover {
        border-color: var(--border-color);
        background: var(--bg-primary);
      }
    }

    .symbol-kind {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--primary-color) 20%, transparent);
      color: var(--primary-color);
      font-size: 10px;
      font-weight: 700;
      font-family: monospace;
      flex-shrink: 0;
      margin-top: 1px;

      &[data-kind="class"] {
        background: color-mix(in srgb, #3b82f6 20%, transparent);
        color: #3b82f6;
      }

      &[data-kind="interface"] {
        background: color-mix(in srgb, #8b5cf6 20%, transparent);
        color: #8b5cf6;
      }

      &[data-kind="variable"],
      &[data-kind="const"] {
        background: color-mix(in srgb, #10b981 20%, transparent);
        color: #10b981;
      }
    }

    .symbol-info {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
      flex: 1;
    }

    .symbol-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .symbol-container {
      font-size: 11px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .symbol-path {
      font-size: 11px;
      color: var(--text-muted);
      font-family: monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .stats-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-sm) var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      flex-shrink: 0;
    }

    .stat-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
    }

    .stat-label {
      color: var(--text-muted);
    }

    .stat-value {
      font-weight: 700;
      color: var(--text-primary);
    }

    @media (max-width: 1080px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodebasePageComponent {
  private readonly codebaseIpc = inject(CodebaseIpcService);

  readonly symbolQuery = signal('');
  readonly symbolResults = signal<SymbolResult[]>([]);
  readonly searchingSymbols = signal(false);
  readonly refreshing = signal(false);

  readonly symbolResultCount = computed(() => this.symbolResults().length);

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async refresh(): Promise<void> {
    if (this.refreshing()) {
      return;
    }
    this.refreshing.set(true);
    try {
      // Re-run symbol search with current query if one exists
      if (this.symbolQuery().trim()) {
        await this.searchSymbols();
      }
    } finally {
      this.refreshing.set(false);
    }
  }

  onSymbolInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.symbolQuery.set(value);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => this.searchSymbols(), 300);
  }

  async searchSymbols(): Promise<void> {
    const query = this.symbolQuery().trim();
    if (!query) {
      this.symbolResults.set([]);
      return;
    }
    this.searchingSymbols.set(true);
    try {
      const resp = await this.codebaseIpc.searchSymbols('default', query);
      this.symbolResults.set(this.unwrapData<SymbolResult[]>(resp, []));
    } finally {
      this.searchingSymbols.set(false);
    }
  }

  onOpenFile(event: { filePath: string; line?: number }): void {
    // Open file requests from the codebase panel are surfaced here for
    // potential future integration (e.g. editor bridge IPC).
    // No-op for now; the panel handles its own display.
    void event;
  }

  openSymbol(symbol: SymbolResult): void {
    // Emit open-file via the panel's existing IPC pathway once integrated.
    // For now trigger any external editor bridge if available.
    void symbol;
  }

  kindIcon(kind: string): string {
    return SYMBOL_KIND_ICONS[kind.toLowerCase()] ?? kind.charAt(0).toUpperCase();
  }

  private unwrapData<T>(response: IpcResponse, fallback: T): T {
    return response.success ? ((response.data as T) ?? fallback) : fallback;
  }
}
