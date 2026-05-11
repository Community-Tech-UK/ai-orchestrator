/**
 * SessionArtifactsStrip — shows files the agent created or modified in the
 * current session, filtered to user-facing artifacts (markdown, PDFs, images,
 * CSVs, etc.) rather than source code.
 *
 * Renders directly above the input panel in `app-chat-detail`. Hidden when
 * there are no artifacts. Clicking a chip opens the file in the configured
 * external editor (or the system default app for binary office docs / PDFs /
 * images). Right-click exposes Reveal in Finder / Copy path / Copy as
 * Markdown link.
 *
 * Data source: `Instance.diffStats.files` — already populated by the main
 * process's `SessionDiffTracker`. No new IPC required.
 *
 * Most logic lives in `session-artifacts.util.ts` as pure functions so it can
 * be unit-tested without TestBed (the repo's vitest config doesn't include
 * the Angular compiler plugin, so signal `input()` metadata isn't generated).
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  type Signal,
} from '@angular/core';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import type { Instance } from '../../core/state/instance/instance.types';
import { type ArtifactCategory } from '../../../../shared/utils/artifact-extensions';
import {
  applyStatusFilter,
  buildArtifactEntries,
  COLLAPSED_STORAGE_PREFIX,
  defaultOpenStrategy,
  formatChipTooltip,
  formatMarkdownLink,
  summarizeArtifacts,
  type ArtifactEntry,
  type ArtifactStatus,
  type StatusFilter,
} from './session-artifacts.util';

interface ContextMenuState {
  readonly entry: ArtifactEntry;
  readonly x: number;
  readonly y: number;
}

/** Threshold above which the strip auto-collapses on first render. */
const AUTO_COLLAPSE_THRESHOLD = 8;

/** Maximum image preview byte size — keep it small for instant thumbnails. */
const IMAGE_PREVIEW_MAX_BYTES = 256 * 1024;

const STATUS_SYMBOL: Record<ArtifactStatus, string> = {
  added: '✨',
  modified: '~',
  deleted: '−',
};

const CATEGORY_ICON: Record<ArtifactCategory, string> = {
  doc: '📝',
  office: '📘',
  data: '📊',
  image: '🖼️',
  notebook: '📓',
};

@Component({
  selector: 'app-session-artifacts-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (entries().length > 0) {
      <section class="artifacts-strip" [class.collapsed]="collapsed()">
        <header class="strip-header">
          <button
            type="button"
            class="header-toggle"
            (click)="onToggleCollapse()"
            [attr.aria-expanded]="!collapsed()"
            [title]="collapsed() ? 'Expand artifacts' : 'Collapse artifacts'"
          >
            <span class="caret">{{ collapsed() ? '▸' : '▾' }}</span>
            <span class="header-title">Artifacts</span>
            <span class="header-counts">
              @if (summary().added > 0) {
                <span class="count count-added">{{ summary().added }} new</span>
              }
              @if (summary().modified > 0) {
                <span class="count count-modified">{{ summary().modified }} updated</span>
              }
              @if (summary().deleted > 0) {
                <span class="count count-deleted">{{ summary().deleted }} deleted</span>
              }
            </span>
          </button>

          @if (!collapsed()) {
            <div class="filter-pills" role="tablist" aria-label="Filter artifacts">
              <button
                type="button"
                class="pill"
                [class.active]="statusFilter() === 'all'"
                (click)="statusFilter.set('all')"
                role="tab"
                [attr.aria-selected]="statusFilter() === 'all'"
              >
                All <span class="pill-count">{{ entries().length }}</span>
              </button>
              @if (summary().added > 0) {
                <button
                  type="button"
                  class="pill pill-added"
                  [class.active]="statusFilter() === 'added'"
                  (click)="statusFilter.set('added')"
                  role="tab"
                  [attr.aria-selected]="statusFilter() === 'added'"
                >
                  New <span class="pill-count">{{ summary().added }}</span>
                </button>
              }
              @if (summary().modified > 0) {
                <button
                  type="button"
                  class="pill pill-modified"
                  [class.active]="statusFilter() === 'modified'"
                  (click)="statusFilter.set('modified')"
                  role="tab"
                  [attr.aria-selected]="statusFilter() === 'modified'"
                >
                  Updated <span class="pill-count">{{ summary().modified }}</span>
                </button>
              }
              @if (summary().deleted > 0) {
                <button
                  type="button"
                  class="pill pill-deleted"
                  [class.active]="statusFilter() === 'deleted'"
                  (click)="statusFilter.set('deleted')"
                  role="tab"
                  [attr.aria-selected]="statusFilter() === 'deleted'"
                >
                  Deleted <span class="pill-count">{{ summary().deleted }}</span>
                </button>
              }
            </div>
          }
        </header>

        @if (!collapsed()) {
          <div class="chip-row">
            @for (entry of visibleEntries(); track entry.relPath) {
              <button
                type="button"
                class="chip"
                [class.chip-added]="entry.status === 'added'"
                [class.chip-modified]="entry.status === 'modified'"
                [class.chip-deleted]="entry.status === 'deleted'"
                [class.chip-image]="entry.category === 'image'"
                [title]="chipTooltip(entry)"
                (click)="onClickChip(entry)"
                (contextmenu)="onContextMenu($event, entry)"
              >
                @if (entry.category === 'image' && imageThumbs().get(entry.absPath); as thumb) {
                  <span
                    class="chip-thumb"
                    [style.background-image]="'url(' + thumb + ')'"
                    aria-hidden="true"
                  ></span>
                } @else {
                  <span class="chip-status" [attr.data-status]="entry.status" aria-hidden="true">
                    {{ statusSymbol(entry.status) }}
                  </span>
                  <span class="chip-icon" aria-hidden="true">{{ categoryIcon(entry.category) }}</span>
                }
                <span class="chip-name">{{ entry.basename }}</span>
                @if (entry.outsideCwd) {
                  <span class="chip-outside" title="Outside working directory" aria-label="Outside working directory">↗</span>
                }
              </button>
            }
          </div>
        }
      </section>

      @if (contextMenu(); as menu) {
        <button
          type="button"
          class="ctx-menu-backdrop"
          aria-label="Close menu"
          (click)="contextMenu.set(null)"
          (keydown.escape)="contextMenu.set(null)"
          (contextmenu)="$event.preventDefault(); contextMenu.set(null)"
        ></button>
        <div
          class="ctx-menu"
          role="menu"
          [style.left.px]="menu.x"
          [style.top.px]="menu.y"
        >
          <button type="button" role="menuitem" (click)="openInEditor(menu.entry); contextMenu.set(null)">
            Open in editor
          </button>
          <button type="button" role="menuitem" (click)="openWithDefault(menu.entry); contextMenu.set(null)">
            Open with default app
          </button>
          <button type="button" role="menuitem" (click)="revealInFinder(menu.entry); contextMenu.set(null)">
            Reveal in file manager
          </button>
          <div class="ctx-divider"></div>
          <button type="button" role="menuitem" (click)="copyPath(menu.entry); contextMenu.set(null)">
            Copy path
          </button>
          <button type="button" role="menuitem" (click)="copyMarkdownLink(menu.entry); contextMenu.set(null)">
            Copy as markdown link
          </button>
        </div>
      }
    }
  `,
  styles: [`
    :host {
      display: block;
      flex-shrink: 0;
    }

    .artifacts-strip {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin: 0 4px;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      background: var(--glass-light, rgba(255, 255, 255, 0.03));
    }
    .artifacts-strip.collapsed { padding-bottom: 6px; }

    .strip-header {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .header-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 2px 4px;
      background: transparent;
      border: 0;
      cursor: pointer;
      color: var(--text-secondary);
      font: inherit;
    }
    .header-toggle:hover { color: var(--text-primary); }

    .caret {
      display: inline-block;
      width: 12px;
      text-align: center;
      font-size: 10px;
      color: var(--text-muted);
    }

    .header-title {
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-secondary);
    }

    .header-counts {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .count {
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.04em;
      color: var(--text-muted);
    }
    .count.count-added    { color: rgba(95, 215, 138, 0.86); }
    .count.count-modified { color: rgba(245, 200, 75, 0.86); }
    .count.count-deleted  { color: rgba(255, 125, 114, 0.86); }

    .filter-pills {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: auto;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 22px;
      padding: 0 9px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      background: transparent;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.04em;
      cursor: pointer;
      transition: all var(--transition-fast, 120ms ease);
    }
    .pill:hover {
      color: var(--text-primary);
      border-color: rgba(255, 255, 255, 0.14);
    }
    .pill.active {
      color: var(--text-primary);
      border-color: rgba(var(--primary-rgb, 122, 197, 255), 0.42);
      background: rgba(var(--primary-rgb, 122, 197, 255), 0.12);
    }
    .pill.pill-added.active {
      border-color: rgba(95, 215, 138, 0.5);
      background: rgba(95, 215, 138, 0.14);
    }
    .pill.pill-modified.active {
      border-color: rgba(245, 200, 75, 0.5);
      background: rgba(245, 200, 75, 0.14);
    }
    .pill.pill-deleted.active {
      border-color: rgba(255, 125, 114, 0.5);
      background: rgba(255, 125, 114, 0.14);
    }
    .pill-count { opacity: 0.74; }

    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding: 0 10px 0 8px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.025);
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast, 120ms ease);
      max-width: 320px;
    }
    .chip:hover {
      border-color: rgba(var(--primary-rgb, 122, 197, 255), 0.42);
      background: rgba(var(--primary-rgb, 122, 197, 255), 0.08);
      transform: translateY(-1px);
    }
    .chip:active { transform: translateY(0); }
    .chip.chip-added {
      border-color: rgba(95, 215, 138, 0.3);
      background: rgba(95, 215, 138, 0.06);
    }
    .chip.chip-added:hover {
      border-color: rgba(95, 215, 138, 0.6);
      background: rgba(95, 215, 138, 0.12);
    }
    .chip.chip-modified {
      border-color: rgba(245, 200, 75, 0.26);
      background: rgba(245, 200, 75, 0.05);
    }
    .chip.chip-modified:hover {
      border-color: rgba(245, 200, 75, 0.56);
      background: rgba(245, 200, 75, 0.12);
    }
    .chip.chip-deleted {
      border-color: rgba(255, 125, 114, 0.26);
      background: rgba(255, 125, 114, 0.05);
      color: var(--text-muted);
      text-decoration: line-through;
      text-decoration-color: rgba(255, 125, 114, 0.48);
    }
    .chip.chip-deleted:hover {
      border-color: rgba(255, 125, 114, 0.56);
      background: rgba(255, 125, 114, 0.12);
    }
    .chip.chip-image { padding-left: 4px; }

    .chip-status {
      font-size: 11px;
      width: 12px;
      text-align: center;
    }
    .chip-status[data-status='added']    { color: rgba(95, 215, 138, 0.94); }
    .chip-status[data-status='modified'] { color: rgba(245, 200, 75, 0.94); }
    .chip-status[data-status='deleted']  { color: rgba(255, 125, 114, 0.94); }

    .chip-icon { font-size: 12px; }

    .chip-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chip-thumb {
      display: inline-block;
      width: 22px;
      height: 22px;
      border-radius: 4px;
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      border: 1px solid rgba(255, 255, 255, 0.08);
      flex-shrink: 0;
    }

    .chip-outside {
      margin-left: 2px;
      font-size: 10px;
      color: var(--text-muted);
      opacity: 0.7;
    }

    .ctx-menu-backdrop {
      position: fixed;
      inset: 0;
      z-index: 999;
      background: transparent;
      border: 0;
      padding: 0;
      cursor: default;
    }

    .ctx-menu {
      position: fixed;
      z-index: 1000;
      min-width: 200px;
      padding: 4px;
      border-radius: 8px;
      background: var(--bg-secondary, #1a1a1f);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
    }
    .ctx-menu button {
      display: block;
      width: 100%;
      padding: 6px 10px;
      text-align: left;
      background: transparent;
      border: 0;
      border-radius: 5px;
      color: var(--text-primary);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .ctx-menu button:hover {
      background: rgba(var(--primary-rgb, 122, 197, 255), 0.14);
    }

    .ctx-divider {
      height: 1px;
      margin: 4px 6px;
      background: rgba(255, 255, 255, 0.06);
    }
  `],
})
export class SessionArtifactsStripComponent {
  private readonly fileIpc = inject(FileIpcService);

  /** Diff stats from the current instance (already piped from the main process). */
  readonly diffStats = input<Instance['diffStats'] | null | undefined>(null);

  /** Working directory used to resolve relative paths back to absolute. */
  readonly workingDirectory = input<string | null | undefined>(null);

  /** Chat id, used to scope collapsed-state persistence. */
  readonly chatId = input<string | null | undefined>(null);

  // -------------------------------------------------------------------------
  // UI state
  // -------------------------------------------------------------------------

  readonly statusFilter = signal<StatusFilter>('all');
  readonly collapsed = signal<boolean>(false);
  readonly contextMenu = signal<ContextMenuState | null>(null);
  /** Map of absolute path → data URL for thumbnails (lazy-populated). */
  readonly imageThumbs = signal<Map<string, string>>(new Map());

  // Track which images we've already attempted to load so we don't retry on
  // every render. Stored outside the signal map because failed attempts
  // shouldn't keep firing fetches.
  private readonly thumbAttempts = new Set<string>();

  // -------------------------------------------------------------------------
  // Derived state (logic lives in `session-artifacts.util.ts`)
  // -------------------------------------------------------------------------

  /** All artifact entries sorted: New first, then Updated, then Deleted; alpha within. */
  readonly entries: Signal<readonly ArtifactEntry[]> = computed(() =>
    buildArtifactEntries(this.diffStats(), this.workingDirectory())
  );

  /** Counts per status, used by header pills. */
  readonly summary = computed(() => summarizeArtifacts(this.entries()));

  /** Entries after applying the active filter pill. */
  readonly visibleEntries = computed<readonly ArtifactEntry[]>(() =>
    applyStatusFilter(this.entries(), this.statusFilter())
  );

  // -------------------------------------------------------------------------
  // Constructor: load persisted collapsed state, react to chat changes, lazy
  // load image thumbnails.
  // -------------------------------------------------------------------------

  constructor() {
    // When the chat id changes, load its persisted collapsed preference.
    effect(() => {
      const id = this.chatId();
      this.collapsed.set(this.loadCollapsed(id));
      // Reset filter on chat switch so a new session starts at "All".
      this.statusFilter.set('all');
      // Clear thumbs so we don't show stale images from a previous chat.
      this.imageThumbs.set(new Map());
      this.thumbAttempts.clear();
    });

    // Auto-collapse when entries grow past the threshold AND the user hasn't
    // explicitly toggled this chat's state. We only auto-collapse on the
    // transition from "under threshold" to "over threshold" — once the user
    // has expanded, they stay expanded for that chat.
    effect(() => {
      const total = this.entries().length;
      const chatId = this.chatId();
      if (total > AUTO_COLLAPSE_THRESHOLD && chatId && !this.hasUserPreference(chatId)) {
        this.collapsed.set(true);
      }
    });

    // Lazy-load image thumbnails for visible image chips.
    effect(() => {
      if (this.collapsed()) return;
      for (const entry of this.visibleEntries()) {
        if (entry.category !== 'image') continue;
        if (this.thumbAttempts.has(entry.absPath)) continue;
        this.thumbAttempts.add(entry.absPath);
        void this.loadImageThumb(entry.absPath);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  onToggleCollapse(): void {
    const next = !this.collapsed();
    this.collapsed.set(next);
    this.persistCollapsed(this.chatId(), next);
  }

  async onClickChip(entry: ArtifactEntry): Promise<void> {
    if (defaultOpenStrategy(entry.category) === 'default-app') {
      await this.openWithDefault(entry);
    } else {
      await this.openInEditor(entry);
    }
  }

  onContextMenu(event: MouseEvent, entry: ArtifactEntry): void {
    event.preventDefault();
    this.contextMenu.set({ entry, x: event.clientX, y: event.clientY });
  }

  async openInEditor(entry: ArtifactEntry): Promise<void> {
    await this.fileIpc.editorOpen(entry.absPath, { line: 1 });
  }

  async openWithDefault(entry: ArtifactEntry): Promise<void> {
    await this.fileIpc.openPath(entry.absPath);
  }

  async revealInFinder(entry: ArtifactEntry): Promise<void> {
    await this.fileIpc.revealFile(entry.absPath);
  }

  async copyPath(entry: ArtifactEntry): Promise<void> {
    try {
      await navigator.clipboard.writeText(entry.absPath);
    } catch {
      // Fall back to file-clipboard IPC if Clipboard API is blocked.
      await this.fileIpc.copyFileToClipboard(entry.absPath);
    }
  }

  async copyMarkdownLink(entry: ArtifactEntry): Promise<void> {
    try {
      await navigator.clipboard.writeText(formatMarkdownLink(entry));
    } catch {
      // Best-effort: silently swallow if clipboard is blocked.
    }
  }

  // -------------------------------------------------------------------------
  // Template helpers
  // -------------------------------------------------------------------------

  statusSymbol(status: ArtifactStatus): string {
    return STATUS_SYMBOL[status];
  }

  categoryIcon(category: ArtifactCategory): string {
    return CATEGORY_ICON[category];
  }

  chipTooltip(entry: ArtifactEntry): string {
    return formatChipTooltip(entry);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async loadImageThumb(absPath: string): Promise<void> {
    try {
      const result = await this.fileIpc.readFileBytes(absPath, IMAGE_PREVIEW_MAX_BYTES);
      if (!result) return;

      const ext = absPath.split('.').pop()?.toLowerCase() ?? '';
      const mime = mimeForImageExtension(ext);
      const bytes = new Uint8Array(result.buffer);

      // Build base64 in chunks to avoid `Maximum call stack size exceeded` on
      // larger images.
      const chunkSize = 0x8000;
      let binary = '';
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      const dataUrl = `data:${mime};base64,${btoa(binary)}`;

      this.imageThumbs.update((map) => {
        const next = new Map(map);
        next.set(absPath, dataUrl);
        return next;
      });
    } catch {
      // Best-effort: leave thumbnail unrendered if read fails.
    }
  }

  private storageKey(chatId: string | null | undefined): string | null {
    if (!chatId) return null;
    return COLLAPSED_STORAGE_PREFIX + chatId;
  }

  private loadCollapsed(chatId: string | null | undefined): boolean {
    const key = this.storageKey(chatId);
    if (!key) return false;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return false;
      return raw === '1';
    } catch {
      return false;
    }
  }

  private hasUserPreference(chatId: string | null | undefined): boolean {
    const key = this.storageKey(chatId);
    if (!key) return false;
    try {
      return localStorage.getItem(key) !== null;
    } catch {
      return false;
    }
  }

  private persistCollapsed(chatId: string | null | undefined, value: boolean): void {
    const key = this.storageKey(chatId);
    if (!key) return;
    try {
      localStorage.setItem(key, value ? '1' : '0');
    } catch {
      // Ignore storage errors.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mimeForImageExtension(ext: string): string {
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'bmp':
      return 'image/bmp';
    case 'svg':
      return 'image/svg+xml';
    case 'heic':
    case 'heif':
      return 'image/heic';
    default:
      return 'application/octet-stream';
  }
}
