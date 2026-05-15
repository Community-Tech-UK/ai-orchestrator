import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type { InstanceStatus } from '../../../../shared/types/instance.types';
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

const MAX_VISIBLE_TASKS = 5;
const MAX_VISIBLE_OUTPUTS = 6;

@Component({
  selector: 'app-session-progress-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shouldRender()) {
      @if (expanded()) {
        <aside class="progress-panel" aria-label="Session progress">
          <header class="panel-header">
            <div class="panel-title-group">
              <span class="panel-title">Progress</span>
              @if (hasTodos()) {
                <span class="panel-count">{{ stats().completed }}/{{ stats().total }}</span>
              }
            </div>
            <div class="panel-actions">
              <button
                type="button"
                class="icon-button"
                title="Collapse progress"
                aria-label="Collapse progress"
                (click)="collapsePanel()"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12"></path>
                </svg>
              </button>
            </div>
          </header>

          @if (hasTodos()) {
            <div class="progress-meter" aria-label="Task completion">
              <div class="progress-track">
                <div class="progress-fill" [style.width.%]="stats().percentComplete"></div>
              </div>
              <span class="progress-percent">{{ stats().percentComplete }}%</span>
            </div>

            <div class="task-list">
              @for (todo of visibleTodos(); track todo.id) {
                <div
                  class="task-row"
                  [class.status-pending]="todo.status === 'pending'"
                  [class.status-in_progress]="todo.status === 'in_progress'"
                  [class.status-completed]="todo.status === 'completed'"
                  [class.status-cancelled]="todo.status === 'cancelled'"
                >
                  <span class="task-status" aria-hidden="true">
                    <span class="status-mark"></span>
                  </span>
                  <span class="task-text">{{ taskLabel(todo) }}</span>
                </div>
              }
              @if (hiddenTodoCount() > 0) {
                <div class="more-row">{{ hiddenTodoCount() }} more</div>
              }
            </div>
          }

          @if (outputs().length > 0) {
            <div class="section-divider"></div>
            <section class="outputs-section" aria-label="Generated document outputs">
              <div class="section-heading">
                <span>Outputs</span>
                <span>{{ outputs().length }}</span>
              </div>
              <div class="output-list">
                @for (entry of visibleOutputs(); track entry.relPath) {
                  <button
                    type="button"
                    class="output-row"
                    [class.output-deleted]="entry.status === 'deleted'"
                    [title]="outputTooltip(entry)"
                    (click)="openOutput(entry)"
                  >
                    <span class="file-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"></path>
                        <path d="M14 2v5h5"></path>
                        <path d="M8 13h8M8 17h6"></path>
                      </svg>
                    </span>
                    <span class="output-main">
                      <span class="output-name">{{ entry.basename }}</span>
                      <span class="output-meta">{{ outputMeta(entry) }}</span>
                    </span>
                  </button>
                }
                @if (hiddenOutputCount() > 0) {
                  <div class="more-row">{{ hiddenOutputCount() }} more outputs</div>
                }
              </div>
            </section>
          }
        </aside>
      } @else {
        <button
          type="button"
          class="progress-tab"
          title="Show progress"
          aria-label="Show progress"
          (click)="expandPanel()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 11l3 3L22 4"></path>
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
          </svg>
          <span>{{ collapsedSummary() }}</span>
        </button>
      }
    }
  `,
  styles: [`
    :host {
      position: absolute;
      top: 18px;
      right: 18px;
      z-index: 5;
      width: min(360px, calc(100% - 36px));
      pointer-events: none;
    }

    .progress-panel,
    .progress-tab {
      pointer-events: auto;
      border: 1px solid rgba(255, 255, 255, 0.09);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.015)),
        rgba(24, 27, 26, 0.92);
      box-shadow: 0 18px 46px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(18px);
    }

    .progress-panel {
      display: flex;
      flex-direction: column;
      max-height: min(58vh, 560px);
      overflow: hidden;
      border-radius: 18px;
      color: var(--text-primary);
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 14px 10px;
      background: rgba(255, 255, 255, 0.025);
    }

    .panel-title-group,
    .panel-actions,
    .progress-meter,
    .section-heading,
    .output-row,
    .progress-tab {
      display: flex;
      align-items: center;
    }

    .panel-title-group {
      min-width: 0;
      gap: 8px;
    }

    .panel-title,
    .section-heading,
    .panel-count,
    .progress-percent,
    .more-row,
    .output-meta,
    .progress-tab {
      font-family: var(--font-mono);
    }

    .panel-title {
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 650;
    }

    .panel-count {
      color: var(--text-muted);
      font-size: 11px;
    }

    .icon-button {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .icon-button:hover,
    .progress-tab:hover {
      color: var(--text-primary);
      border-color: rgba(var(--primary-rgb), 0.34);
      background: rgba(var(--primary-rgb), 0.11);
    }

    svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .progress-meter {
      gap: 10px;
      padding: 10px 14px 8px;
    }

    .progress-track {
      flex: 1;
      height: 5px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
    }

    .progress-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, rgba(88, 166, 255, 0.95), rgba(74, 222, 128, 0.9));
      transition: width 180ms ease;
    }

    .progress-percent {
      width: 36px;
      text-align: right;
      color: var(--text-muted);
      font-size: 10px;
    }

    .task-list,
    .output-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      overflow: auto;
    }

    .task-list {
      padding: 0 14px 10px;
    }

    .task-row {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      min-height: 24px;
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.35;
    }

    .task-status {
      display: grid;
      place-items: center;
      width: 18px;
      height: 18px;
      margin-top: 1px;
    }

    .status-mark {
      width: 12px;
      height: 12px;
      border: 2px solid rgba(255, 255, 255, 0.45);
      border-radius: 50%;
    }

    .status-completed {
      color: var(--text-muted);
    }

    .status-completed .task-text {
      text-decoration: line-through;
      text-decoration-thickness: 1px;
      opacity: 0.68;
    }

    .status-completed .status-mark {
      position: relative;
      border-color: rgba(74, 222, 128, 0.72);
      background: rgba(74, 222, 128, 0.18);
    }

    .status-completed .status-mark::after {
      content: '';
      position: absolute;
      left: 3px;
      top: 1px;
      width: 4px;
      height: 7px;
      border: solid rgba(187, 247, 208, 0.95);
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }

    .status-in_progress .status-mark {
      border-color: rgba(88, 166, 255, 0.3);
      border-top-color: rgba(88, 166, 255, 0.95);
      animation: spin 900ms linear infinite;
    }

    .status-cancelled .status-mark {
      border-color: rgba(255, 125, 114, 0.72);
      background:
        linear-gradient(45deg, transparent 42%, rgba(255, 125, 114, 0.95) 42%, rgba(255, 125, 114, 0.95) 58%, transparent 58%),
        linear-gradient(-45deg, transparent 42%, rgba(255, 125, 114, 0.95) 42%, rgba(255, 125, 114, 0.95) 58%, transparent 58%);
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .task-text,
    .output-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .section-divider {
      height: 1px;
      margin: 0 14px;
      background: rgba(255, 255, 255, 0.08);
    }

    .outputs-section {
      min-height: 0;
      padding: 10px 0 12px;
    }

    .section-heading {
      justify-content: space-between;
      padding: 0 14px 8px;
      color: var(--text-muted);
      font-size: 11px;
    }

    .output-list {
      padding: 0 8px;
    }

    .output-row {
      gap: 9px;
      width: 100%;
      min-width: 0;
      padding: 7px 8px;
      border: 1px solid transparent;
      border-radius: 10px;
      background: transparent;
      color: var(--text-primary);
      text-align: left;
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .output-row:hover {
      border-color: rgba(var(--primary-rgb), 0.22);
      background: rgba(var(--primary-rgb), 0.08);
    }

    .output-deleted {
      color: var(--text-muted);
      text-decoration: line-through;
      text-decoration-color: rgba(255, 125, 114, 0.5);
    }

    .file-icon {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      width: 22px;
      height: 22px;
      color: var(--text-secondary);
    }

    .output-main {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: 1px;
    }

    .output-name {
      white-space: nowrap;
      font-size: 13px;
      line-height: 1.25;
    }

    .output-meta {
      color: var(--text-muted);
      font-size: 10px;
      line-height: 1.25;
      text-transform: uppercase;
    }

    .more-row {
      padding: 4px 8px 0 26px;
      color: var(--text-muted);
      font-size: 10px;
    }

    .progress-tab {
      justify-content: center;
      gap: 8px;
      max-width: 100%;
      min-height: 34px;
      margin-left: auto;
      padding: 0 12px;
      border-radius: 999px;
      color: var(--text-secondary);
      font-size: 11px;
      cursor: pointer;
    }

    .progress-tab span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    @media (max-width: 840px) {
      :host {
        top: 10px;
        right: 10px;
        width: min(340px, calc(100% - 20px));
      }

      .progress-panel {
        max-height: min(48vh, 460px);
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
  readonly instanceStatus = input<InstanceStatus | null>(null);

  readonly expanded = signal(true);
  private readonly userCollapsed = signal(false);
  private lastSessionId: string | null = null;

  readonly outputs = computed(() =>
    buildArtifactEntries(this.diffStats(), this.workingDirectory())
  );

  readonly hasTodos = computed(() =>
    this.todoStore.currentSessionId() === this.sessionId() && this.todoStore.hasTodos()
  );

  readonly stats = computed(() => this.todoStore.stats());

  readonly visibleTodos = computed<readonly TodoItem[]>(() =>
    this.hasTodos() ? this.todoStore.todos().slice(0, MAX_VISIBLE_TASKS) : []
  );

  readonly hiddenTodoCount = computed(() =>
    this.hasTodos() ? Math.max(0, this.todoStore.todos().length - MAX_VISIBLE_TASKS) : 0
  );

  readonly visibleOutputs = computed<readonly ArtifactEntry[]>(() =>
    this.outputs().slice(0, MAX_VISIBLE_OUTPUTS)
  );

  readonly hiddenOutputCount = computed(() =>
    Math.max(0, this.outputs().length - MAX_VISIBLE_OUTPUTS)
  );

  readonly shouldRender = computed(() =>
    this.hasTodos() || this.outputs().length > 0
  );

  readonly collapsedSummary = computed(() => {
    const parts: string[] = [];
    if (this.hasTodos()) {
      parts.push(`${this.stats().completed}/${this.stats().total}`);
    }
    if (this.outputs().length > 0) {
      parts.push(`${this.outputs().length} outputs`);
    }
    return parts.join(' / ') || 'Progress';
  });

  constructor() {
    effect(() => {
      const sessionId = this.sessionId();
      if (sessionId !== this.lastSessionId) {
        this.lastSessionId = sessionId;
        this.userCollapsed.set(false);
        this.expanded.set(true);
      }
      void this.todoStore.setSession(sessionId);
    });

    effect(() => {
      if (
        this.shouldRender()
        && this.isWorkingStatus(this.instanceStatus())
        && !this.userCollapsed()
      ) {
        this.expanded.set(true);
      }
    });
  }

  collapsePanel(): void {
    this.userCollapsed.set(true);
    this.expanded.set(false);
  }

  expandPanel(): void {
    this.userCollapsed.set(false);
    this.expanded.set(true);
  }

  taskLabel(todo: TodoItem): string {
    return todo.status === 'in_progress'
      ? todo.activeForm || todo.content
      : todo.content;
  }

  outputTooltip(entry: ArtifactEntry): string {
    return formatChipTooltip(entry);
  }

  outputMeta(entry: ArtifactEntry): string {
    return `${statusLabel(entry.status)} / ${entry.category}`;
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

  private isWorkingStatus(status: InstanceStatus | null): boolean {
    return status === 'busy'
      || status === 'processing'
      || status === 'thinking_deeply'
      || status === 'waiting_for_permission';
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
