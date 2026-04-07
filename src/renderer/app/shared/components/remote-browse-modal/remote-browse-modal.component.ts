import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NodePathPipe } from '../../pipes/node-path.pipe';
import { RemoteFsIpcService } from '../../../core/services/ipc/remote-fs-ipc.service';
import { RemoteNodeStore } from '../../../core/state/remote-node.store';
import type { FsEntry, FsProjectMatch } from '../../../../../shared/types/remote-fs.types';

@Component({
  selector: 'app-remote-browse-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, NodePathPipe],
  template: `
    @if (isOpen()) {
      <div class="modal-overlay" (click)="close()" (keydown.escape)="close()" tabindex="-1" role="dialog" aria-modal="true">
        <div class="modal-container" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()" role="document">

          <!-- Header -->
          <div class="modal-header">
            <div class="modal-header-top">
              <span class="modal-title">Select Working Directory</span>
              <div class="mode-toggle">
                <button
                  type="button"
                  class="mode-btn"
                  [class.active]="mode() === 'browse'"
                  (click)="mode.set('browse')"
                >
                  Browse
                </button>
                <button
                  type="button"
                  class="mode-btn"
                  [class.active]="mode() === 'search'"
                  (click)="mode.set('search')"
                >
                  Search
                </button>
              </div>
              <button type="button" class="close-btn" (click)="close()">✕</button>
            </div>

            @if (mode() === 'browse') {
              <div class="breadcrumbs">
                @for (crumb of breadcrumbs(); track crumb.path) {
                  <button
                    type="button"
                    class="breadcrumb-item"
                    (click)="navigateTo(crumb.path)"
                  >{{ crumb.name }}</button>
                  <span class="breadcrumb-sep">›</span>
                }
              </div>
            }
          </div>

          <!-- Body -->
          <div class="modal-body">
            @if (mode() === 'browse') {
              @if (isLoading()) {
                <div class="loading-state">Loading…</div>
              } @else if (entries().length === 0) {
                <div class="empty-state">No directories found.</div>
              } @else {
                <div class="entry-list">
                  @for (entry of entries(); track entry.path) {
                    <button
                      type="button"
                      class="entry-item"
                      [class.selected]="selectedPath() === entry.path"
                      (click)="onEntryClick(entry)"
                      (dblclick)="onEntryDoubleClick(entry)"
                    >
                      <span class="entry-icon">📁</span>
                      <span class="entry-name">{{ entry.name }}</span>
                      <span class="entry-path">{{ entry.path | nodePath:platform() }}</span>
                    </button>
                  }
                  @if (truncated()) {
                    <div class="truncated-notice">Some entries were omitted. Navigate into a folder to see more.</div>
                  }
                </div>
              }
            } @else {
              <div class="search-area">
                <input
                  type="text"
                  class="search-input"
                  placeholder="Search for a project folder…"
                  [ngModel]="searchQuery()"
                  (ngModelChange)="onSearchInput($event)"

                />
                <div class="search-results">
                  @if (searchResults().length === 0 && searchQuery().length > 0) {
                    <div class="empty-state">No results for "{{ searchQuery() }}"</div>
                  }
                  @for (match of searchResults(); track match.path) {
                    <button
                      type="button"
                      class="result-item"
                      [class.selected]="selectedPath() === match.path"
                      (click)="selectSearchResult(match)"
                    >
                      <span class="result-name">{{ match.name }}</span>
                      <span class="result-path">{{ match.path | nodePath:platform() }}</span>
                      @if (match.markers.length > 0) {
                        <span class="result-markers">{{ match.markers.join(', ') }}</span>
                      }
                    </button>
                  }
                </div>
              </div>
            }
          </div>

          <!-- Footer -->
          <div class="modal-footer">
            <div class="selected-path">
              @if (selectedPath()) {
                <span class="selected-label">Selected:</span>
                <span class="selected-value">{{ selectedPath() | nodePath:platform() }}</span>
              } @else {
                <span class="selected-placeholder">No folder selected</span>
              }
            </div>
            <div class="footer-actions">
              <button type="button" class="btn btn-secondary" (click)="close()">Cancel</button>
              <button
                type="button"
                class="btn btn-primary"
                [disabled]="!selectedPath()"
                (click)="confirm()"
              >
                Select
              </button>
            </div>
          </div>

        </div>
      </div>
    }
  `,
  styles: [`
    .modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .modal-container {
      width: 640px;
      max-width: 90vw;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      background: var(--surface-bg, var(--bg-secondary, #1e1e2e));
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
      border-radius: 10px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }

    /* Header */
    .modal-header {
      padding: 16px 16px 0;
      border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
      flex-shrink: 0;
    }

    .modal-header-top {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }

    .modal-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary, #cdd6f4);
      flex: 1;
    }

    .mode-toggle {
      display: flex;
      background: var(--bg-tertiary, rgba(0, 0, 0, 0.2));
      border-radius: 6px;
      padding: 2px;
    }

    .mode-btn {
      padding: 4px 12px;
      border: none;
      background: transparent;
      color: var(--text-secondary, #a6adc8);
      font-size: 12px;
      cursor: pointer;
      border-radius: 4px;
      transition: all 0.15s;
    }

    .mode-btn.active {
      background: var(--accent-color, #89b4fa);
      color: #1e1e2e;
      font-weight: 500;
    }

    .close-btn {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: transparent;
      color: var(--text-muted, #6c7086);
      font-size: 14px;
      cursor: pointer;
      border-radius: 4px;
    }

    .close-btn:hover {
      background: var(--hover-bg, rgba(255, 255, 255, 0.08));
      color: var(--text-primary, #cdd6f4);
    }

    .breadcrumbs {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 2px;
      padding-bottom: 10px;
      min-height: 30px;
    }

    .breadcrumb-item {
      border: none;
      background: transparent;
      color: var(--accent-color, #89b4fa);
      font-size: 12px;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
    }

    .breadcrumb-item:hover {
      background: var(--hover-bg, rgba(255, 255, 255, 0.08));
    }

    .breadcrumb-sep {
      color: var(--text-muted, #6c7086);
      font-size: 12px;
      pointer-events: none;
    }

    /* Body */
    .modal-body {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
    }

    .loading-state,
    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 120px;
      color: var(--text-muted, #6c7086);
      font-size: 13px;
    }

    .entry-list {
      display: flex;
      flex-direction: column;
    }

    .entry-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border: none;
      background: transparent;
      color: var(--text-primary, #cdd6f4);
      font-size: 13px;
      cursor: pointer;
      text-align: left;
      width: 100%;
      transition: background 0.1s;
    }

    .entry-item:hover {
      background: var(--hover-bg, rgba(255, 255, 255, 0.06));
    }

    .entry-item.selected {
      background: rgba(137, 180, 250, 0.12);
      color: var(--accent-color, #89b4fa);
    }

    .entry-icon {
      font-size: 14px;
      flex-shrink: 0;
    }

    .entry-name {
      font-weight: 500;
      flex-shrink: 0;
    }

    .entry-path {
      font-size: 11px;
      color: var(--text-muted, #6c7086);
      margin-left: auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 260px;
    }

    .truncated-notice {
      padding: 8px 16px;
      font-size: 11px;
      color: var(--text-muted, #6c7086);
      border-top: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
    }

    /* Search */
    .search-area {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .search-input {
      margin: 12px 16px 8px;
      padding: 8px 12px;
      background: var(--bg-tertiary, rgba(0, 0, 0, 0.2));
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
      border-radius: 6px;
      color: var(--text-primary, #cdd6f4);
      font-size: 13px;
      outline: none;
    }

    .search-input:focus {
      border-color: var(--accent-color, #89b4fa);
    }

    .search-results {
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }

    .result-item {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: 10px 16px;
      border: none;
      background: transparent;
      color: var(--text-primary, #cdd6f4);
      font-size: 13px;
      cursor: pointer;
      text-align: left;
      width: 100%;
      transition: background 0.1s;
    }

    .result-item:hover {
      background: var(--hover-bg, rgba(255, 255, 255, 0.06));
    }

    .result-item.selected {
      background: rgba(137, 180, 250, 0.12);
    }

    .result-name {
      font-weight: 500;
    }

    .result-path {
      font-size: 11px;
      color: var(--text-muted, #6c7086);
    }

    .result-markers {
      font-size: 11px;
      color: var(--text-secondary, #a6adc8);
    }

    /* Footer */
    .modal-footer {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-top: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
      flex-shrink: 0;
    }

    .selected-path {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      overflow: hidden;
    }

    .selected-label {
      font-size: 12px;
      color: var(--text-secondary, #a6adc8);
      flex-shrink: 0;
    }

    .selected-value {
      font-size: 12px;
      color: var(--text-primary, #cdd6f4);
      font-family: var(--font-mono, monospace);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .selected-placeholder {
      font-size: 12px;
      color: var(--text-muted, #6c7086);
      font-style: italic;
    }

    .footer-actions {
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }

    .btn {
      padding: 6px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.15s;
    }

    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .btn-secondary {
      background: transparent;
      border-color: var(--border-color, rgba(255, 255, 255, 0.1));
      color: var(--text-secondary, #a6adc8);
    }

    .btn-secondary:hover:not(:disabled) {
      background: var(--hover-bg, rgba(255, 255, 255, 0.08));
      color: var(--text-primary, #cdd6f4);
    }

    .btn-primary {
      background: var(--accent-color, #89b4fa);
      color: #1e1e2e;
    }

    .btn-primary:hover:not(:disabled) {
      filter: brightness(1.1);
    }
  `],
})
export class RemoteBrowseModalComponent {
  private readonly remoteFsIpc = inject(RemoteFsIpcService);
  private readonly nodeStore = inject(RemoteNodeStore);

  nodeId = input.required<string>();
  isOpen = input(false);
  folderSelected = output<string>();
  closed = output<void>();

  readonly mode = signal<'browse' | 'search'>('browse');
  readonly currentPath = signal('');
  readonly entries = signal<FsEntry[]>([]);
  readonly truncated = signal(false);
  readonly selectedPath = signal<string | null>(null);
  readonly isLoading = signal(false);
  readonly searchQuery = signal('');
  readonly searchResults = signal<FsProjectMatch[]>([]);

  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly openEffect = effect(() => {
    const open = this.isOpen();
    if (!open) return;

    const node = this.nodeStore.nodeById(this.nodeId());
    const roots = node?.capabilities?.browsableRoots ?? [];
    const startPath = roots[0] ?? (this.platform() === 'win32' ? 'C:\\' : '/');

    this.currentPath.set(startPath);
    this.selectedPath.set(null);
    this.mode.set('browse');
    this.searchQuery.set('');
    this.searchResults.set([]);
    this.loadDirectory(startPath);
  });

  readonly platform = computed(() => {
    const node = this.nodeStore.nodeById(this.nodeId());
    return node?.capabilities.platform ?? 'linux';
  });

  readonly breadcrumbs = computed((): { name: string; path: string }[] => {
    const path = this.currentPath();
    if (!path) return [];

    const sep = this.platform() === 'win32' ? '\\' : '/';
    const parts = path.split(sep).filter(p => p.length > 0);

    return parts.map((part, index) => {
      const segmentPath = sep + parts.slice(0, index + 1).join(sep);
      return { name: part, path: segmentPath };
    });
  });

  open(initialPath: string): void {
    this.currentPath.set(initialPath);
    this.selectedPath.set(null);
    this.loadDirectory(initialPath);
  }

  navigateTo(dirPath: string): void {
    this.currentPath.set(dirPath);
    this.selectedPath.set(dirPath);
    this.loadDirectory(dirPath);
  }

  onEntryClick(entry: FsEntry): void {
    if (entry.isDirectory) {
      this.selectedPath.set(entry.path);
    }
  }

  onEntryDoubleClick(entry: FsEntry): void {
    if (entry.isDirectory) {
      this.navigateTo(entry.path);
    }
  }

  selectSearchResult(match: FsProjectMatch): void {
    this.selectedPath.set(match.path);
  }

  toggleMode(): void {
    this.mode.set(this.mode() === 'browse' ? 'search' : 'browse');
  }

  onSearchInput(query: string): void {
    this.searchQuery.set(query);
    if (this.searchDebounceTimer !== null) {
      clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = setTimeout(async () => {
      this.searchDebounceTimer = null;
      if (!query.trim()) {
        this.searchResults.set([]);
        return;
      }
      const result = await this.remoteFsIpc.search(this.nodeId(), query);
      this.searchResults.set(result?.results ?? []);
    }, 300);
  }

  confirm(): void {
    const path = this.selectedPath();
    if (path) {
      this.folderSelected.emit(path);
      this.close();
    }
  }

  close(): void {
    this.closed.emit();
  }

  private async loadDirectory(dirPath: string): Promise<void> {
    this.isLoading.set(true);
    this.entries.set([]);
    this.truncated.set(false);
    try {
      const result = await this.remoteFsIpc.readDirectory(this.nodeId(), dirPath, { depth: 2 });
      if (result) {
        const dirs = result.entries.filter(e => e.isDirectory);
        this.entries.set(dirs);
        this.truncated.set(result.truncated);
      }
    } finally {
      this.isLoading.set(false);
    }
  }
}
