import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { windowTodos } from './todo-window';
import type { TodoItem } from '../../../../shared/types/todo.types';
import { TodoStore } from '../../core/state/todo.store';
import type { Instance } from '../../core/state/instance/instance.types';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import {
  buildArtifactEntries,
  defaultOpenStrategy,
  formatChipTooltip,
  type ArtifactEntry,
} from '../chats/session-artifacts.util';
import {
  readStorage,
  writeStorage,
  type StorageField,
} from '../../shared/utils/typed-storage';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';

const MAX_VISIBLE_TASKS = 5;
/** Documents named on the folded strip; the rest are one click away. */
const MAX_STRIP_DOCUMENTS = 3;

interface OutputContextMenuState {
  readonly entry: ArtifactEntry;
  readonly x: number;
  readonly y: number;
}

/**
 * Whether the strip is unfolded is sticky: persisted to localStorage so it
 * stays as the user left it across session switches and app restarts.
 */
export const STRIP_EXPANDED_FIELD: StorageField<boolean> = {
  key: 'session-work-strip:expanded',
  version: 1,
  defaultValue: false,
  validate: (value): value is boolean => typeof value === 'boolean',
};

/**
 * One slim strip between the session header and the chat: the agent's task
 * progress and the documents it has made. It sits in the page flow, never on
 * top of the header or the conversation, and unfolds in place for the full
 * task and document lists.
 */
@Component({
  selector: 'app-session-progress-panel',
  standalone: true,
  imports: [AioTooltipDirective, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shouldRender()) {
      <section class="work-strip" [class.expanded]="expanded()" aria-label="Tasks and documents for this session">
        <div class="strip-row">
          <button
            type="button"
            #toggle
            class="strip-toggle"
            [attr.aria-expanded]="expanded()"
            [attr.aria-controls]="expanded() ? 'session-work-strip-detail' : null"
            [appTooltip]="toggleTooltip()"
            (click)="toggleExpanded()"
          >
            <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>
            @if (hasTodos()) {
              <span class="strip-label">Tasks</span>
              <span class="mini-track" aria-hidden="true">
                <span class="mini-fill" [style.width.%]="stats().percentComplete"></span>
              </span>
              <span class="strip-count">{{ stats().completed }} of {{ stats().total }} done</span>
              @if (!expanded() && currentTask(); as task) {
                <span class="current-task">Now: {{ taskLabel(task) }}</span>
              }
            } @else {
              <span class="strip-label">{{ documentCountLabel() }}</span>
            }
          </button>

          @if (!expanded() && outputs().length > 0) {
            <div class="strip-documents">
              @for (entry of stripOutputs(); track entry.relPath) {
                <ng-container *ngTemplateOutlet="docChip; context: { $implicit: entry, showStatus: false }" />
              }
              @if (hiddenStripOutputCount() > 0) {
                <button type="button" class="doc-more" (click)="showAllDocuments()">+{{ hiddenStripOutputCount() }} more</button>
              }
            </div>
          }
        </div>

        @if (expanded()) {
          <div class="strip-detail" id="session-work-strip-detail">
            @if (hasTodos()) {
              <div class="task-list">
                @for (todo of visibleTodos(); track todo.id) {
                  <div
                    class="task-row"
                    [class.status-pending]="todo.status === 'pending'"
                    [class.status-in_progress]="todo.status === 'in_progress'"
                    [class.status-completed]="todo.status === 'completed'"
                    [class.status-cancelled]="todo.status === 'cancelled'"
                  >
                    <span class="task-status" aria-hidden="true"><span class="status-mark"></span></span>
                    <span class="task-text">{{ taskLabel(todo) }}</span>
                  </div>
                }
                @if (todoToggleLabel(); as label) {
                  <button type="button" class="more-row" [attr.aria-expanded]="showAllTodos()" (click)="showAllTodos.set(!showAllTodos())">{{ label }}</button>
                }
              </div>
            }

            @if (outputs().length > 0) {
              <section class="documents" aria-label="Documents made in this session">
                @if (hasTodos()) {
                  <div class="section-heading">{{ documentCountLabel() }}</div>
                }
                <div class="document-list">
                  @for (entry of outputs(); track entry.relPath) {
                    <ng-container *ngTemplateOutlet="docChip; context: { $implicit: entry, showStatus: true }" />
                  }
                </div>
              </section>
            }
          </div>
        }
      </section>

      <ng-template #docChip let-entry let-showStatus="showStatus">
        <button
          type="button"
          class="doc-chip"
          [class.doc-deleted]="entry.status === 'deleted'"
          [appTooltip]="outputTooltip(entry)"
          (click)="openOutput(entry)"
          (contextmenu)="onOutputContextMenu($event, entry)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"></path>
            <path d="M14 2v5h5"></path>
          </svg>
          <span class="doc-name">{{ entry.basename }}</span>
          @if (showStatus) {
            <span class="doc-status">{{ statusWord(entry) }}</span>
          }
        </button>
      </ng-template>

      @if (outputMenu(); as menu) {
        <button
          type="button"
          class="ctx-menu-backdrop"
          data-ui-hints-exempt="backdrop"
          aria-label="Close menu"
          (click)="outputMenu.set(null)"
          (keydown.escape)="outputMenu.set(null)"
          (contextmenu)="$event.preventDefault(); outputMenu.set(null)"
        ></button>
        <div class="ctx-menu" role="menu" [style.left.px]="menu.x" [style.top.px]="menu.y">
          @if (menu.entry.status !== 'deleted') {
            <button
              type="button"
              role="menuitem"
              (click)="openWithDefault(menu.entry); outputMenu.set(null)"
            >
              Open with preferred program
            </button>
            <button
              type="button"
              role="menuitem"
              (click)="openInEditor(menu.entry); outputMenu.set(null)"
            >
              Open in editor
            </button>
            <button
              type="button"
              role="menuitem"
              (click)="revealInFinder(menu.entry); outputMenu.set(null)"
            >
              Open in Finder
            </button>
            <div class="ctx-divider"></div>
          }
          <button
            type="button"
            role="menuitem"
            (click)="copyPath(menu.entry); outputMenu.set(null)"
          >
            Copy path
          </button>
        </div>
      }
    }
  `,
  styles: [`
    /* In the page flow between the header and the chat, so it can never cover
       either. An empty host must not take a gap in the parent's flex column. */
    :host {
      display: block;
      flex-shrink: 0;
    }

    :host:empty {
      display: none;
    }

    .work-strip {
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      color: var(--text-secondary);
      font-size: 12px;
    }

    .strip-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
      padding: 0 6px;
    }

    .strip-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1 1 auto;
      min-width: 0;
      padding: 6px 6px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .strip-toggle:hover {
      color: var(--text-primary);
      background: rgba(255, 255, 255, 0.04);
    }

    button:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 1px;
    }

    svg {
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .chevron {
      width: 12px;
      height: 12px;
      color: var(--text-muted);
      transition: transform var(--transition-fast);
    }

    .expanded .chevron {
      transform: rotate(90deg);
    }

    .strip-label {
      flex: 0 0 auto;
      color: var(--text-primary);
      font-weight: 600;
    }

    .mini-track {
      flex: 0 0 64px;
      height: 4px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
    }

    .mini-fill {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--success-color);
      transition: width 180ms ease;
    }

    .strip-count {
      flex: 0 0 auto;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    .current-task,
    .doc-name,
    .task-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .current-task {
      flex: 1 1 auto;
    }

    .strip-documents {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 1 auto;
      min-width: 0;
      max-width: 60%;
      overflow: hidden;
    }

    .document-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .doc-chip,
    .doc-more {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      max-width: 220px;
      padding: 3px 8px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-secondary);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }

    .doc-more {
      flex: 0 0 auto;
      color: var(--text-muted);
    }

    .doc-chip:hover,
    .doc-more:hover {
      color: var(--text-primary);
      border-color: rgba(var(--primary-rgb), 0.3);
      background: rgba(var(--primary-rgb), 0.08);
    }

    .doc-deleted .doc-name {
      text-decoration: line-through;
      color: var(--text-muted);
    }

    .doc-status {
      flex: 0 0 auto;
      color: var(--text-muted);
      font-size: 10px;
    }

    .strip-detail {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: min(32vh, 280px);
      overflow: auto;
      padding: 2px 12px 10px 28px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }

    .task-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding-top: 8px;
    }

    .task-row {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      min-height: 22px;
      line-height: 1.35;
    }

    .task-status {
      display: grid;
      place-items: center;
      width: 16px;
      height: 16px;
    }

    .status-mark {
      width: 10px;
      height: 10px;
      border: 2px solid rgba(255, 255, 255, 0.4);
      border-radius: 50%;
    }

    .status-in_progress {
      color: var(--text-primary);
    }

    .status-in_progress .status-mark {
      border-color: rgba(88, 166, 255, 0.3);
      border-top-color: rgba(88, 166, 255, 0.95);
      animation: spin 900ms linear infinite;
    }

    .status-completed {
      color: var(--text-muted);
    }

    .status-completed .task-text {
      text-decoration: line-through;
      text-decoration-thickness: 1px;
      opacity: 0.7;
    }

    .status-completed .status-mark {
      border-color: rgba(74, 222, 128, 0.72);
      background: rgba(74, 222, 128, 0.45);
    }

    .status-cancelled .status-mark {
      border-color: rgba(255, 125, 114, 0.72);
    }

    .status-cancelled .task-text {
      text-decoration: line-through;
      color: var(--text-muted);
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .more-row {
      align-self: flex-start;
      padding: 2px 0 0 24px;
      border: 0;
      background: transparent;
      color: var(--text-muted);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }

    .more-row:hover {
      color: var(--text-primary);
    }

    .documents {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-top: 8px;
    }

    .section-heading {
      color: var(--text-muted);
      font-size: 11px;
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
      min-width: 208px;
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
      background: rgba(var(--primary-rgb), 0.14);
    }

    .ctx-divider {
      height: 1px;
      margin: 4px 6px;
      background: rgba(255, 255, 255, 0.06);
    }

    @media (max-width: 840px) {
      .mini-track,
      .current-task {
        display: none;
      }
    }
  `],
})
export class SessionProgressPanelComponent {
  private readonly fileIpc = inject(FileIpcService);
  readonly todoStore = inject(TodoStore);

  readonly sessionId = input<string | null>(null);
  readonly diffStats = input<Instance['diffStats'] | null | undefined>(null);
  readonly workingDirectory = input<string | null | undefined>(null);

  /** Sticky, persisted unfold state — see STRIP_EXPANDED_FIELD. */
  readonly expanded = signal<boolean>(readStorage(STRIP_EXPANDED_FIELD));
  private readonly toggle = viewChild<ElementRef<HTMLButtonElement>>('toggle');

  /** Open right-click context menu for a document (null = closed). */
  readonly outputMenu = signal<OutputContextMenuState | null>(null);

  readonly outputs = computed(() =>
    buildArtifactEntries(this.diffStats(), this.workingDirectory())
  );

  readonly hasTodos = computed(() =>
    this.todoStore.currentSessionId() === this.sessionId() && this.todoStore.hasTodos()
  );

  readonly stats = computed(() => this.todoStore.stats());

  readonly currentTask = computed(() =>
    this.hasTodos() ? this.todoStore.todos().find((todo) => todo.status === 'in_progress') ?? null : null
  );

  readonly showAllTodos = signal(false);
  readonly todoWindow = computed(() => windowTodos(this.hasTodos() ? this.todoStore.todos() : [], MAX_VISIBLE_TASKS, this.showAllTodos()));
  readonly visibleTodos = computed<readonly TodoItem[]>(() => this.todoWindow().rows);
  /** One button for both directions, so keyboard focus stays on it when the list changes. */
  readonly todoToggleLabel = computed(() => {
    const { earlier, later } = this.todoWindow();
    if (earlier || later) return `${earlier || later} ${earlier ? 'earlier' : 'more'}`;
    return this.showAllTodos() && this.todoStore.todos().length > 5 ? 'Show fewer' : null;
  });

  readonly stripOutputs = computed<readonly ArtifactEntry[]>(() =>
    this.outputs().slice(0, MAX_STRIP_DOCUMENTS)
  );

  readonly hiddenStripOutputCount = computed(() =>
    Math.max(0, this.outputs().length - MAX_STRIP_DOCUMENTS)
  );

  readonly documentCountLabel = computed(() => {
    const count = this.outputs().length;
    return count === 1 ? '1 document' : `${count} documents`;
  });

  readonly toggleTooltip = computed(() => {
    const lists = this.hasTodos() && this.outputs().length > 0 ? 'task and document lists'
      : this.hasTodos() ? 'task list' : 'document list';
    return `${this.expanded() ? 'Hide' : 'Show'} the ${lists}`;
  });

  readonly shouldRender = computed(() =>
    this.hasTodos() || this.outputs().length > 0
  );

  constructor() {
    // Keep the TODO store pointed at the strip's session. The unfold
    // preference is deliberately left untouched on session changes.
    effect(() => {
      void this.todoStore.setSession(this.sessionId());
      this.showAllTodos.set(false);
    });
  }

  /** The +N more button goes away once the strip unfolds, so keyboard focus moves to the toggle that stays. */
  showAllDocuments(): void {
    this.toggleExpanded();
    this.toggle()?.nativeElement.focus();
  }

  toggleExpanded(): void {
    const expanded = !this.expanded();
    this.expanded.set(expanded);
    writeStorage(STRIP_EXPANDED_FIELD, expanded);
  }

  taskLabel(todo: TodoItem): string {
    return todo.status === 'in_progress'
      ? todo.activeForm || todo.content
      : todo.content;
  }

  outputTooltip(entry: ArtifactEntry): string {
    return formatChipTooltip(entry);
  }

  statusWord(entry: ArtifactEntry): string {
    return statusLabel(entry.status);
  }

  async openOutput(entry: ArtifactEntry): Promise<void> {
    if (entry.status === 'deleted') {
      return;
    }
    if (defaultOpenStrategy(entry.category) === 'default-app') {
      await this.fileIpc.openPath(entry.absPath);
    } else {
      await this.fileIpc.editorOpen(entry.absPath, { line: 1 });
    }
  }

  onOutputContextMenu(event: MouseEvent, entry: ArtifactEntry): void {
    event.preventDefault();
    this.outputMenu.set({ entry, x: event.clientX, y: event.clientY });
  }

  /** Open with the OS's preferred program for the file type (Electron shell.openPath). */
  async openWithDefault(entry: ArtifactEntry): Promise<void> {
    await this.fileIpc.openPath(entry.absPath);
  }

  async openInEditor(entry: ArtifactEntry): Promise<void> {
    await this.fileIpc.editorOpen(entry.absPath, { line: 1 });
  }

  /** Reveal the file in Finder / the system file manager. */
  async revealInFinder(entry: ArtifactEntry): Promise<void> {
    await this.fileIpc.revealFile(entry.absPath);
  }

  async copyPath(entry: ArtifactEntry): Promise<void> {
    try {
      await navigator.clipboard.writeText(entry.absPath);
    } catch {
      // Fall back to file-clipboard IPC if the Clipboard API is blocked.
      await this.fileIpc.copyFileToClipboard(entry.absPath);
    }
  }
}

function statusLabel(status: ArtifactEntry['status']): string {
  switch (status) {
    case 'added':
      return 'New';
    case 'modified':
      return 'Updated';
    case 'deleted':
      return 'Deleted';
  }
}
