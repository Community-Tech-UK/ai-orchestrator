/**
 * Instance Row Component - Single instance in the hierarchical tree list
 */

import {
  Component,
  input,
  output,
  computed,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { Instance } from '../../core/state/instance.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';

@Component({
  selector: 'app-instance-row',
  standalone: true,
  imports: [],
  template: `
    <div
      class="instance-row"
      [class.selected]="isSelected()"
      [class.error]="instance().status === 'error'"
      [class.needs-attention]="needsAttention()"
      [class.yolo]="instance().yoloMode"
      [class.is-child]="depth() > 0"
      [class.draggable]="isDraggable()"
      [style.padding-left.px]="6 + depth() * 18"
      (click)="instanceSelect.emit(instance().id)"
      (keydown.enter)="instanceSelect.emit(instance().id)"
      (keydown.space)="instanceSelect.emit(instance().id)"
      tabindex="0"
      role="button"
      [attr.aria-label]="'Select instance ' + resolvedDisplayTitle()"
    >
      <!-- Child connector for non-root children without their own children -->
      @if (!hasChildren() && depth() > 0) {
        <span class="child-connector">└</span>
      }

      <span class="leading-indicator" [title]="needsAttention() ? activityLabel() : showActivitySpinner() ? activityLabel() : isHibernated() ? 'Hibernated — click to wake' : providerVisual().label">
        @if (needsAttention()) {
          <span class="attention-dot" [title]="activityLabel()"></span>
        } @else if (showActivitySpinner()) {
          <span class="activity-spinner"></span>
        } @else if (isHibernated()) {
          <span class="hibernated-indicator" title="Hibernated — click to wake">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="10" opacity="0.4"/>
            </svg>
          </span>
        } @else {
          <span class="provider-badge" [style.color]="providerVisual().color">
            @switch (providerVisual().icon) {
              @case ('anthropic') {
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 1.75c.48 0 .87.39.87.87v4.04a.87.87 0 1 1-1.74 0V2.62c0-.48.39-.87.87-.87Z"/>
                  <path d="M17.88 3.33c.41.24.55.77.32 1.19l-2.02 3.5a.87.87 0 1 1-1.5-.87l2.02-3.5a.87.87 0 0 1 1.18-.32Z"/>
                  <path d="M21.82 7.47c.24.41.1.95-.32 1.18L18 10.67a.87.87 0 0 1-.87-1.5l3.5-2.02a.87.87 0 0 1 1.19.32Z"/>
                  <path d="M22.25 12c0 .48-.39.87-.87.87h-4.04a.87.87 0 1 1 0-1.74h4.04c.48 0 .87.39.87.87Z"/>
                  <path d="M20.67 17.88a.87.87 0 0 1-1.18.32l-3.5-2.02a.87.87 0 1 1 .87-1.5l3.5 2.02c.41.24.55.77.31 1.18Z"/>
                  <path d="M16.53 21.82a.87.87 0 0 1-1.18-.32l-2.02-3.5a.87.87 0 1 1 1.5-.87l2.02 3.5c.24.41.1.95-.32 1.19Z"/>
                  <path d="M12 22.25a.87.87 0 0 1-.87-.87v-4.04a.87.87 0 1 1 1.74 0v4.04c0 .48-.39.87-.87.87Z"/>
                  <path d="M7.47 20.67a.87.87 0 0 1-.32-1.18l2.02-3.5a.87.87 0 1 1 1.5.87l-2.02 3.5a.87.87 0 0 1-1.18.31Z"/>
                  <path d="M3.33 16.53a.87.87 0 0 1 .32-1.18l3.5-2.02a.87.87 0 1 1 .87 1.5l-3.5 2.02a.87.87 0 0 1-1.19-.32Z"/>
                  <path d="M1.75 12c0-.48.39-.87.87-.87h4.04a.87.87 0 1 1 0 1.74H2.62a.87.87 0 0 1-.87-.87Z"/>
                  <path d="M3.33 7.47a.87.87 0 0 1 1.18-.32l3.5 2.02a.87.87 0 1 1-.87 1.5l-3.5-2.02a.87.87 0 0 1-.31-1.18Z"/>
                  <path d="M7.47 3.33c.41-.24.95-.1 1.18.32l2.02 3.5a.87.87 0 1 1-1.5.87l-2.02-3.5a.87.87 0 0 1 .32-1.19Z"/>
                  <circle cx="12" cy="12" r="1.65"/>
                </svg>
              }
              @case ('openai') {
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.985 5.985 0 0 0 .517 4.91 6.046 6.046 0 0 0 6.51 2.9A6.065 6.065 0 0 0 19.02 19.81a5.985 5.985 0 0 0 3.998-2.9 6.046 6.046 0 0 0-.736-7.09z"/>
                </svg>
              }
              @case ('google') {
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
              }
              @case ('github') {
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                </svg>
              }
              @case ('ollama') {
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                  <path d="M12 3.5c-4.6 0-8.5 3.1-8.5 7s3.9 7 8.5 7 8.5-3.1 8.5-7-3.9-7-8.5-7Z"/>
                  <path d="M8.5 10h.01M15.5 10h.01"/>
                  <path d="M9 13.5c.8.8 1.8 1.2 3 1.2s2.2-.4 3-1.2"/>
                </svg>
              }
            }
          </span>
        }
      </span>

      <div class="instance-info">
        <div class="instance-name-row">
          @if (hasUnreadCompletion()) {
            <span class="unread-dot" title="Completed — click to view"></span>
          }
          <span class="instance-name">{{ resolvedDisplayTitle() }}</span>
          @if (hasPendingApproval()) {
            <span class="approval-chip" title="This instance has a pending permission request">Awaiting approval</span>
          }
          @if (hasChildren() && !isExpanded()) {
            <span class="collapsed-badge" title="Child instances (click arrow to expand)">+{{ instance().childrenIds.length }}</span>
          }
        </div>
        @if (isRemote()) {
          <span
            class="remote-badge"
            [class.remote-badge-warning]="remoteNodeDisconnected()"
            [title]="remoteNodeBadgeTitle()"
          >
            {{ remoteNodeName() }}
          </span>
        }
      </div>

      @if (hasDiffStats()) {
        <div class="diff-stats" [title]="diffTooltip()">
          @if (diffStatsLabel().added) {
            <span class="diff-added">{{ diffStatsLabel().added }}</span>
          }
          @if (diffStatsLabel().deleted) {
            <span class="diff-deleted">{{ diffStatsLabel().deleted }}</span>
          }
        </div>
      }

      @if (lastActivityLabel()) {
        <div class="instance-meta">
          <span class="instance-time">{{ lastActivityLabel() }}</span>
        </div>
      }

      <!-- Expand/collapse button on the right for parent instances -->
      @if (hasChildren()) {
        <button
          class="expand-btn"
          [class.expanded]="isExpanded()"
          (click)="onToggleExpand($event)"
          title="{{ isExpanded() ? 'Collapse' : 'Expand' }} children"
        >
          <span class="chevron">›</span>
        </button>
      }

      <div class="instance-actions">
        <button
          class="action-btn restart"
          title="Restart instance"
          (click)="onRestart($event)"
          [disabled]="instance().status === 'initializing'"
        >
          ↻
        </button>
        <button
          class="action-btn terminate"
          title="Terminate instance"
          (click)="onTerminate($event)"
        >
          ×
        </button>
      </div>
    </div>
  `,
  styles: [`
    /* Instance Row - Clean list item with refined interactions */
    .instance-row {
      display: flex;
      align-items: center;
      padding: 5px 4px;
      gap: 8px;
      cursor: pointer;
      transition: all var(--transition-fast);
      min-height: 30px;
      position: relative;
      background: transparent;
      border-radius: 8px;
    }

    .instance-row:hover {
      background-color: rgba(255, 255, 255, 0.025);
    }

    .instance-row.selected {
      background:
        linear-gradient(90deg, rgba(var(--primary-rgb), 0.12), rgba(255, 255, 255, 0.03)),
        rgba(255, 255, 255, 0.03);
      box-shadow:
        inset 0 0 0 1px rgba(var(--primary-rgb), 0.12),
        inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }

    .instance-row.selected:hover {
      background:
        linear-gradient(90deg, rgba(var(--primary-rgb), 0.14), rgba(255, 255, 255, 0.035)),
        rgba(255, 255, 255, 0.04);
    }

    .instance-row.error {
      background: rgba(var(--error-rgb), 0.08);
    }

    .instance-row.selected.error {
      background:
        linear-gradient(90deg, rgba(var(--error-rgb), 0.14), rgba(var(--error-rgb), 0.06)),
        rgba(var(--error-rgb), 0.08);
      box-shadow:
        inset 0 0 0 1px rgba(var(--error-rgb), 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }

    .instance-row.yolo {
      box-shadow: inset 0 0 0 1px rgba(var(--primary-rgb), 0.14);
    }

    .instance-row.selected.yolo {
      box-shadow:
        inset 0 0 0 1px rgba(var(--primary-rgb), 0.22),
        inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }

    /* Child instance styling - subtle hierarchy indication */
    .instance-row.is-child {
      background-color: transparent;
    }

    .instance-row.is-child:hover {
      background-color: rgba(255, 255, 255, 0.02);
    }

    /* Draggable root instance */
    .instance-row.draggable {
      cursor: grab;
    }

    .instance-row.draggable:active {
      cursor: grabbing;
    }

    .leading-indicator {
      width: 14px;
      height: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .activity-spinner {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 1.5px solid rgba(255, 255, 255, 0.12);
      border-top-color: rgba(230, 236, 229, 0.72);
      border-right-color: rgba(230, 236, 229, 0.72);
      animation: spin 0.7s linear infinite;
    }

    .attention-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #f59e0b;
      box-shadow: 0 0 6px rgba(245, 158, 11, 0.6);
      animation: attention-pulse 2s ease-in-out infinite;
    }

    .instance-row.needs-attention {
      background: rgba(245, 158, 11, 0.06);
    }

    .instance-row.needs-attention:hover {
      background: rgba(245, 158, 11, 0.1);
    }

    .instance-row.selected.needs-attention {
      background:
        linear-gradient(90deg, rgba(245, 158, 11, 0.14), rgba(245, 158, 11, 0.06)),
        rgba(245, 158, 11, 0.06);
      box-shadow:
        inset 0 0 0 1px rgba(245, 158, 11, 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }

    @keyframes attention-pulse {
      0%, 100% {
        opacity: 1;
        box-shadow: 0 0 6px rgba(245, 158, 11, 0.6);
      }
      50% {
        opacity: 0.6;
        box-shadow: 0 0 12px rgba(245, 158, 11, 0.9);
      }
    }

    /* Child connector - Refined tree line */
    .child-connector {
      color: var(--border-color);
      font-size: 12px;
      width: 14px;
      text-align: center;
      flex-shrink: 0;
      opacity: 0.6;
    }

    /* Placeholder for consistent alignment */
    .expand-placeholder {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
    }

    /* Expand/collapse button - Refined interaction */
    .expand-btn {
      width: 16px;
      height: 16px;
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      cursor: pointer;
      transition: all var(--transition-fast);
      flex-shrink: 0;
      color: var(--text-muted);
    }

    .expand-btn:hover {
      background: rgba(var(--primary-rgb), 0.08);
      border-color: rgba(var(--primary-rgb), 0.24);
      color: var(--primary-color);
      transform: scale(1.03);
    }

    .expand-btn .chevron {
      font-size: 10px;
      font-weight: bold;
      line-height: 1;
      transition: transform var(--transition-fast);
    }

    .expand-btn.expanded .chevron {
      transform: rotate(90deg);
    }

    /* Instance Info Section */
    .instance-info {
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }

    .instance-name-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .unread-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #60A5FA;
      box-shadow: 0 0 6px rgba(96, 165, 250, 0.5);
      flex-shrink: 0;
      animation: unread-fade-in 200ms ease-out;
    }

    @keyframes unread-fade-in {
      from { opacity: 0; transform: scale(0.5); }
      to { opacity: 1; transform: scale(1); }
    }

    .diff-stats {
      display: flex;
      gap: 4px;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
      white-space: nowrap;
      padding: 0 4px;
    }

    .diff-added {
      color: #4ade80;
    }

    .diff-deleted {
      color: #f87171;
    }

    .provider-badge {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      opacity: 0.92;
    }

    .provider-badge svg {
      width: 14px;
      height: 14px;
    }

    .hibernated-indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      color: rgba(168, 176, 164, 0.45);
    }

    .hibernated-indicator svg {
      width: 12px;
      height: 12px;
    }

    .instance-name {
      flex: 1;
      min-width: 0;
      font-family: var(--font-display);
      font-weight: 600;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
      color: var(--text-primary);
      letter-spacing: -0.01em;
    }

    .approval-chip {
      background: rgba(74, 222, 128, 0.18);
      color: #4ade80;
      font-family: var(--font-mono);
      font-size: 8px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 999px;
      flex-shrink: 0;
      letter-spacing: 0.02em;
      white-space: nowrap;
      animation: chip-fade-in 200ms ease-out;
    }

    @keyframes chip-fade-in {
      from { opacity: 0; transform: scale(0.9); }
      to { opacity: 1; transform: scale(1); }
    }

    .collapsed-badge {
      background: rgba(var(--primary-rgb), 0.14);
      color: var(--primary-color);
      font-family: var(--font-mono);
      font-size: 8px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 999px;
      flex-shrink: 0;
      letter-spacing: 0.02em;
    }

    .instance-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      margin-left: auto;
      padding-left: 8px;
    }

    .instance-time {
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.02em;
      color: rgba(168, 176, 164, 0.78);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    /* Instance Actions - Action buttons */
    .instance-actions {
      display: flex;
      gap: 3px;
      opacity: 0;
      transition: opacity var(--transition-fast);
      flex-shrink: 0;
    }

    .instance-row:hover .instance-actions {
      opacity: 1;
    }

    .action-btn {
      width: 20px;
      height: 20px;
      border-radius: var(--radius-sm);
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .action-btn.restart {
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-secondary);
      border: 1px solid rgba(255, 255, 255, 0.05);

      &:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.06);
        color: var(--secondary-color);
        border-color: rgba(var(--secondary-rgb), 0.3);
        transform: rotate(180deg);
      }
    }

    .action-btn.terminate {
      background: rgba(var(--error-rgb), 0.1);
      color: var(--error-color);
      border: 1px solid rgba(var(--error-rgb), 0.2);

      &:hover:not(:disabled) {
        background: var(--error-color);
        border-color: var(--error-color);
        color: white;
        box-shadow: 0 0 12px rgba(var(--error-rgb), 0.4);
      }
    }

    .action-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    .remote-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 10px;
      background: rgba(var(--info-rgb), 0.12);
      color: var(--color-info);
      white-space: nowrap;
      margin-left: 4px;
    }

    .remote-badge-warning {
      background: rgba(234, 179, 8, 0.15) !important;
      color: #eab308 !important;
      border-color: rgba(234, 179, 8, 0.3) !important;
    }

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InstanceRowComponent {
  private readonly remoteNodeStore = inject(RemoteNodeStore);

  // Required inputs
  instance = input.required<Instance>();
  displayTitle = input<string | null>(null);

  // Hierarchy inputs
  depth = input<number>(0);
  hasChildren = input<boolean>(false);
  isExpanded = input<boolean>(false);
  isLastChild = input<boolean>(false);
  parentChain = input<boolean[]>([]);

  // Selection state
  isSelected = input<boolean>(false);
  lastActivityLabel = input<string | null>(null);

  // Drag state
  isDraggable = input<boolean>(false);

  // Outputs
  instanceSelect = output<string>();
  terminate = output<string>();
  restart = output<string>();
  toggleExpand = output<string>();
  readonly resolvedDisplayTitle = computed(() => this.displayTitle()?.trim() || this.instance().displayName);

  readonly hasPendingApproval = computed(() =>
    (this.instance().pendingApprovalCount ?? 0) > 0
  );

  readonly hasDiffStats = computed(() => {
    const stats = this.instance().diffStats;
    return stats && (stats.totalAdded > 0 || stats.totalDeleted > 0)
      && this.instance().status !== 'error';
  });

  readonly diffStatsLabel = computed(() => {
    const stats = this.instance().diffStats;
    if (!stats) return { added: '', deleted: '' };
    return {
      added: stats.totalAdded > 0 ? `+${stats.totalAdded}` : '',
      deleted: stats.totalDeleted > 0 ? `-${stats.totalDeleted}` : '',
    };
  });

  readonly hasUnreadCompletion = computed(() => !!this.instance().hasUnreadCompletion);

  readonly diffTooltip = computed(() => {
    const stats = this.instance().diffStats;
    if (!stats || Object.keys(stats.files).length === 0) return '';
    const lines: string[] = [];
    for (const entry of Object.values(stats.files)) {
      const a = entry.added > 0 ? `+${entry.added}` : '';
      const d = entry.deleted > 0 ? `-${entry.deleted}` : '';
      lines.push(`${entry.path}  ${a} ${d}`.trim());
    }
    return lines.join('\n');
  });

  readonly providerVisual = computed(() => {
    switch (this.instance().provider) {
      case 'claude':
        return { icon: 'anthropic', color: '#D97706', label: 'Claude' } as const;
      case 'codex':
        return { icon: 'openai', color: '#10A37F', label: 'Codex' } as const;
      case 'gemini':
        return { icon: 'google', color: '#4285F4', label: 'Gemini' } as const;
      case 'copilot':
        return { icon: 'github', color: '#6e40c9', label: 'Copilot' } as const;
      case 'ollama':
        return { icon: 'ollama', color: '#7dd3fc', label: 'Ollama' } as const;
    }
  });
  readonly needsAttention = computed(() =>
    this.instance().status === 'waiting_for_input'
  );
  readonly showActivitySpinner = computed(() =>
    this.instance().status === 'busy' ||
    this.instance().status === 'processing' ||
    this.instance().status === 'thinking_deeply' ||
    this.instance().status === 'initializing' ||
    this.instance().status === 'respawning' ||
    this.instance().status === 'waking' ||
    this.instance().status === 'hibernating'
  );
  readonly isHibernated = computed(() => this.instance().status === 'hibernated');

  readonly isRemote = computed(() =>
    this.instance().executionLocation?.type === 'remote',
  );

  readonly remoteNodeId = computed(() => {
    const loc = this.instance().executionLocation;
    return loc?.type === 'remote' ? loc.nodeId : '';
  });

  readonly remoteNodeName = computed(() => {
    const nodeId = this.remoteNodeId();
    if (!nodeId) return '';
    const node = this.remoteNodeStore.nodeById(nodeId);
    return node?.name ?? nodeId.slice(0, 8);
  });

  readonly remoteNodeDisconnected = computed(() => {
    const nodeId = this.remoteNodeId();
    if (!nodeId) return false;
    const node = this.remoteNodeStore.nodeById(nodeId);
    return !node || (node.status !== 'connected' && node.status !== 'degraded');
  });

  readonly remoteNodeBadgeTitle = computed(() => {
    const name = this.remoteNodeName();
    return this.remoteNodeDisconnected()
      ? `Node '${name}' disconnected — session may be interrupted`
      : `Running on node: ${name}`;
  });

  readonly activityLabel = computed(() => {
    switch (this.instance().status) {
      case 'busy':
        return 'Working';
      case 'initializing':
        return 'Initializing';
      case 'waiting_for_input':
        return 'Waiting for input';
      case 'respawning':
        return 'Resuming session';
      case 'waking':
        return 'Waking up';
      case 'hibernating':
        return 'Hibernating';
      default:
        return '';
    }
  });

  onTerminate(event: Event): void {
    event.stopPropagation();
    this.terminate.emit(this.instance().id);
  }

  onRestart(event: Event): void {
    event.stopPropagation();
    this.restart.emit(this.instance().id);
  }

  onToggleExpand(event: Event): void {
    event.stopPropagation();
    this.toggleExpand.emit(this.instance().id);
  }

}
