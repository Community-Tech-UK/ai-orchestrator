/**
 * Recent Directories Dropdown Component
 *
 * Dropdown for quick folder selection with:
 * - List of recently accessed directories
 * - Pinned favorites at top
 * - Browse for folder option
 * - Clear recent option
 * - Keyboard navigation
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  inject,
  ChangeDetectionStrategy,
  OnInit,
  ElementRef,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RecentDirectoriesIpcService } from '../../../core/services/ipc/recent-directories-ipc.service';
import type { RecentDirectoryEntry } from '../../../../../shared/types/recent-directories.types';

@Component({
  selector: 'app-recent-directories-dropdown',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dropdown-container" [class.open]="isOpen()">
      <!-- Trigger button -->
      <button
        class="trigger-btn"
        [class.has-value]="currentPath()"
        [title]="currentPath() || 'Click to select a working folder'"
        (click)="toggleDropdown()"
        (keydown.arrowdown)="onTriggerArrowDown($any($event))"
      >
        <span class="folder-icon">📁</span>
        <span class="path-text">{{ displayPath() }}</span>
        <span class="dropdown-caret">▼</span>
      </button>

      <!-- Dropdown menu -->
      @if (isOpen()) {
        <div class="dropdown-menu" role="listbox" #dropdownMenu>
          <div class="search-shell">
            <input
              type="text"
              class="search-input"
              placeholder="Search folders..."
              [value]="searchText()"
              (input)="onSearchInput($event)"
              (keydown.escape)="closeDropdown()"
            />
          </div>

          <!-- Pinned directories -->
          @if (filteredPinnedDirectories().length > 0) {
            <div class="section pinned-section">
              <div class="section-header">Pinned</div>
              @for (dir of filteredPinnedDirectories(); track dir.path; let i = $index) {
                <button
                  class="menu-item"
                  [class.selected]="dir.path === currentPath()"
                  [class.focused]="focusedIndex() === i"
                  [title]="dir.path"
                  role="option"
                  [attr.aria-selected]="dir.path === currentPath()"
                  (click)="selectDirectory(dir)"
                  (contextmenu)="onContextMenu($event, dir)"
                  (mouseenter)="focusedIndex.set(i)"
                >
                  <span class="pin-icon">📌</span>
                  <span class="dir-name">{{ dir.displayName }}</span>
                  @if (dir.path === currentPath()) {
                    <span class="check">✓</span>
                  }
                </button>
              }
            </div>
          }

          <!-- Recent directories -->
          @if (filteredRecentDirectories().length > 0) {
            <div class="section recent-section">
              @if (filteredPinnedDirectories().length > 0) {
                <div class="section-header">Recent</div>
              }
              @for (dir of filteredRecentDirectories(); track dir.path; let i = $index) {
                <button
                  class="menu-item"
                  [class.selected]="dir.path === currentPath()"
                  [class.focused]="focusedIndex() === filteredPinnedDirectories().length + i"
                  [title]="dir.path"
                  role="option"
                  [attr.aria-selected]="dir.path === currentPath()"
                  (click)="selectDirectory(dir)"
                  (contextmenu)="onContextMenu($event, dir)"
                  (mouseenter)="focusedIndex.set(filteredPinnedDirectories().length + i)"
                >
                  <span class="folder-icon">📁</span>
                  <span class="dir-name">{{ dir.displayName }}</span>
                  @if (dir.path === currentPath()) {
                    <span class="check">✓</span>
                  }
                </button>
              }
            </div>
          }

          <!-- Empty state -->
          @if (filteredPinnedDirectories().length === 0 && filteredRecentDirectories().length === 0 && !isLoading()) {
            <div class="empty-state">
              {{ searchText().trim() ? 'No matching folders' : 'No recent directories' }}
            </div>
          }

          <!-- Loading state -->
          @if (isLoading()) {
            <div class="loading-state">
              Loading...
            </div>
          }

          <!-- Divider -->
          <div class="divider"></div>

          <!-- Actions -->
          <div class="section actions-section">
            <button
              class="menu-item action-item"
              (click)="browseForFolder()"
            >
              <span class="action-icon">🔍</span>
              <span>Browse for folder...</span>
            </button>
            @if (pinnedDirectories().length > 0 || recentDirectories().length > 0) {
              <button
                class="menu-item action-item danger"
                (click)="clearRecent()"
              >
                <span class="action-icon">🗑️</span>
                <span>Clear recent</span>
              </button>
            }
          </div>
        </div>

        <!-- Context menu -->
        @if (contextMenuDir()) {
          <div
            class="context-menu"
            [style.top.px]="contextMenuPosition().y"
            [style.left.px]="contextMenuPosition().x"
          >
            @if (!contextMenuDir()!.isPinned) {
              <button class="context-item" (click)="pinDirectory(contextMenuDir()!)">
                📌 Pin to top
              </button>
            } @else {
              <button class="context-item" (click)="unpinDirectory(contextMenuDir()!)">
                📌 Unpin
              </button>
            }
            <button class="context-item danger" (click)="removeDirectory(contextMenuDir()!)">
              🗑️ Remove from list
            </button>
          </div>
        }

        <!-- Backdrop -->
        <button
          type="button"
          class="backdrop"
          aria-label="Close dropdown"
          (click)="closeDropdown()"
        ></button>
      }
    </div>
  `,
  styles: [`
    .dropdown-container {
      position: relative;
      display: inline-block;
    }

    /* Trigger Button */
    .trigger-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      max-width: 300px;
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.02em;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 4px 10px;
      color: var(--text-muted);
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .trigger-btn:hover {
      border-color: var(--primary-color);
      color: var(--text-primary);
      background: rgba(var(--primary-rgb), 0.1);
    }

    .trigger-btn.has-value {
      color: var(--text-secondary);
    }

    .dropdown-container.open .trigger-btn {
      border-color: var(--primary-color);
      background: rgba(var(--primary-rgb), 0.1);
    }

    .path-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: left;
    }

    .dropdown-caret {
      font-size: 8px;
      opacity: 0.6;
      transition: transform var(--transition-fast);
    }

    .dropdown-container.open .dropdown-caret {
      transform: rotate(180deg);
    }

    /* Dropdown Menu */
    .dropdown-menu {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      min-width: 280px;
      max-width: 400px;
      max-height: 400px;
      overflow-y: auto;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      z-index: 1000;
    }

    .search-shell {
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 10px 10px 8px;
      background: linear-gradient(180deg, rgba(14, 21, 20, 0.98), rgba(14, 21, 20, 0.92));
      border-bottom: 1px solid var(--border-subtle);
    }

    .search-input {
      width: 100%;
      height: 34px;
      padding: 0 10px;
      border-radius: 10px;
      border: 1px solid var(--border-subtle);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-primary);
      font-size: 12px;
      outline: none;
      transition: border-color var(--transition-fast), background var(--transition-fast);
    }

    .search-input::placeholder {
      color: var(--text-muted);
    }

    .search-input:focus {
      border-color: rgba(var(--primary-rgb), 0.3);
      background: rgba(var(--primary-rgb), 0.08);
    }

    /* Sections */
    .section {
      padding: 4px 0;
    }

    .section-header {
      padding: 6px 12px 4px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
    }

    /* Menu Items */
    .menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 12px;
      border: none;
      background: transparent;
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      transition: background var(--transition-fast);
    }

    .menu-item:hover,
    .menu-item.focused {
      background: var(--bg-tertiary);
    }

    .menu-item.selected {
      background: rgba(var(--primary-rgb), 0.1);
      color: var(--primary-color);
    }

    .menu-item .folder-icon,
    .menu-item .pin-icon {
      font-size: 14px;
      flex-shrink: 0;
    }

    .menu-item .dir-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .menu-item .check {
      color: var(--primary-color);
      font-size: 12px;
      flex-shrink: 0;
    }

    /* Action Items */
    .action-item {
      color: var(--text-secondary);
    }

    .action-item .action-icon {
      font-size: 14px;
    }

    .action-item.danger:hover {
      background: rgba(var(--error-rgb), 0.1);
      color: var(--error-color);
    }

    /* Divider */
    .divider {
      height: 1px;
      background: var(--border-subtle);
      margin: 4px 0;
    }

    /* Empty & Loading States */
    .empty-state,
    .loading-state {
      padding: 16px 12px;
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
    }

    /* Context Menu */
    .context-menu {
      position: fixed;
      min-width: 160px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      z-index: 1100;
      padding: 4px 0;
    }

    .context-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 12px;
      border: none;
      background: transparent;
      color: var(--text-primary);
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      transition: background var(--transition-fast);
    }

    .context-item:hover {
      background: var(--bg-tertiary);
    }

    .context-item.danger:hover {
      background: rgba(var(--error-rgb), 0.1);
      color: var(--error-color);
    }

    /* Backdrop */
    .backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 999;
      background: transparent;
      border: none;
      cursor: default;
    }
  `],
})
export class RecentDirectoriesDropdownComponent implements OnInit {
  // Inputs
  currentPath = input<string>('');
  placeholder = input<string>('No folder selected');

  // Outputs
  folderSelected = output<string>();

  // State
  isOpen = signal(false);
  isLoading = signal(false);
  directories = signal<RecentDirectoryEntry[]>([]);
  searchText = signal('');
  focusedIndex = signal(-1);
  contextMenuDir = signal<RecentDirectoryEntry | null>(null);
  contextMenuPosition = signal({ x: 0, y: 0 });

  // Dependencies
  private recentDirsService = inject(RecentDirectoriesIpcService);
  private elementRef = inject(ElementRef<HTMLElement>);
  // Computed
  pinnedDirectories = computed(() =>
    this.directories().filter((d) => d.isPinned)
  );

  recentDirectories = computed(() =>
    this.directories().filter((d) => !d.isPinned)
  );

  filteredPinnedDirectories = computed(() =>
    this.filterDirectories(this.pinnedDirectories(), this.searchText())
  );

  filteredRecentDirectories = computed(() =>
    this.filterDirectories(this.recentDirectories(), this.searchText())
  );

  displayPath = computed(() => {
    const path = this.currentPath();
    if (!path) return this.placeholder();

    // Shorten home directory with tilde
    const home = this.getHomePath();
    if (home && path.startsWith(home)) {
      return '~' + path.slice(home.length);
    }

    // Show just the last folder name if path is too long
    if (path.length > 40) {
      const parts = path.split(/[/\\]/);
      return '.../' + parts[parts.length - 1];
    }

    return path;
  });

  ngOnInit(): void {
    this.loadDirectories();
  }

  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    if (!this.isOpen()) return;

    const allDirs = [...this.filteredPinnedDirectories(), ...this.filteredRecentDirectories()];

    switch (event.key) {
      case 'Escape':
        this.closeDropdown();
        event.preventDefault();
        break;
      case 'ArrowDown':
        this.focusedIndex.set(
          Math.min(this.focusedIndex() + 1, allDirs.length - 1)
        );
        event.preventDefault();
        break;
      case 'ArrowUp':
        this.focusedIndex.set(Math.max(this.focusedIndex() - 1, 0));
        event.preventDefault();
        break;
      case 'Enter':
        if (this.focusedIndex() >= 0 && this.focusedIndex() < allDirs.length) {
          this.selectDirectory(allDirs[this.focusedIndex()]);
          event.preventDefault();
        }
        break;
    }
  }

  @HostListener('document:click')
  handleDocumentClick(): void {
    // Close context menu if clicking outside
    if (this.contextMenuDir()) {
      this.contextMenuDir.set(null);
    }
  }

  async loadDirectories(): Promise<void> {
    this.isLoading.set(true);
    try {
      const dirs = await this.recentDirsService.getDirectories({
        sortBy: 'lastAccessed',
      });
      this.directories.set(dirs);
    } finally {
      this.isLoading.set(false);
    }
  }

  toggleDropdown(): void {
    if (this.isOpen()) {
      this.closeDropdown();
    } else {
      this.openDropdown();
    }
  }

  openDropdown(): void {
    this.isOpen.set(true);
    this.focusedIndex.set(-1);
    this.searchText.set('');
    this.loadDirectories();
    requestAnimationFrame(() => {
      const searchInput = this.elementRef.nativeElement.querySelector('.search-input');
      if (searchInput instanceof HTMLInputElement) {
        searchInput.focus();
      }
    });
  }

  closeDropdown(): void {
    this.isOpen.set(false);
    this.contextMenuDir.set(null);
    this.focusedIndex.set(-1);
    this.searchText.set('');
  }

  onTriggerArrowDown(event: KeyboardEvent): void {
    if (!this.isOpen()) {
      this.openDropdown();
      event.preventDefault();
    }
  }

  selectDirectory(dir: RecentDirectoryEntry): void {
    this.folderSelected.emit(dir.path);
    this.closeDropdown();

    // Update access time in background
    this.recentDirsService.addDirectory(dir.path);
  }

  async browseForFolder(): Promise<void> {
    this.closeDropdown();

    const path = await this.recentDirsService.selectFolderAndTrack();
    if (path) {
      this.folderSelected.emit(path);
      // Refresh the list
      this.loadDirectories();
    }
  }

  async clearRecent(): Promise<void> {
    const confirmed = confirm(
      'Clear all recent directories? Pinned items will be kept.'
    );
    if (confirmed) {
      await this.recentDirsService.clearAll(true);
      this.loadDirectories();
    }
  }

  onSearchInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.searchText.set(target?.value ?? '');
    this.focusedIndex.set(-1);
  }

  onContextMenu(event: MouseEvent, dir: RecentDirectoryEntry): void {
    event.preventDefault();
    this.contextMenuDir.set(dir);
    this.contextMenuPosition.set({ x: event.clientX, y: event.clientY });
  }

  async pinDirectory(dir: RecentDirectoryEntry): Promise<void> {
    await this.recentDirsService.pinDirectory(dir.path, true);
    this.contextMenuDir.set(null);
    this.loadDirectories();
  }

  async unpinDirectory(dir: RecentDirectoryEntry): Promise<void> {
    await this.recentDirsService.pinDirectory(dir.path, false);
    this.contextMenuDir.set(null);
    this.loadDirectories();
  }

  async removeDirectory(dir: RecentDirectoryEntry): Promise<void> {
    await this.recentDirsService.removeDirectory(dir.path);
    this.contextMenuDir.set(null);
    this.loadDirectories();
  }

  private getHomePath(): string {
    // Try to get home path from environment or common patterns
    if (typeof process !== 'undefined' && process.env?.['HOME']) {
      return process.env['HOME'];
    }
    // Fallback: detect common home path patterns
    const path = this.currentPath();
    const homeMatch = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+|C:\\Users\\[^\\]+)/);
    return homeMatch ? homeMatch[1] : '';
  }

  private filterDirectories(
    directories: RecentDirectoryEntry[],
    searchText: string
  ): RecentDirectoryEntry[] {
    const normalizedSearch = searchText.trim().toLowerCase();
    if (!normalizedSearch) {
      return directories;
    }

    return directories.filter((directory) =>
      directory.displayName.toLowerCase().includes(normalizedSearch) ||
      directory.path.toLowerCase().includes(normalizedSearch)
    );
  }
}
