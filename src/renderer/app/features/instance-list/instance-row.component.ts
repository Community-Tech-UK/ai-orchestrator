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
      (contextmenu)="onContextMenu($event)"
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
        <span
          class="provider-badge"
          [class.provider-busy]="showActivitySpinner()"
          [class.provider-looping]="isLooping()"
          [class.provider-hibernated]="isHibernated()"
          [class.provider-needs-attention]="needsAttention()"
          [style.color]="providerVisual().color"
          [style.--provider-color]="providerVisual().color"
        >
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
              @case ('cursor') {
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 2 L20 7 L20 17 L12 22 L4 17 L4 7 Z"/>
                </svg>
              }
            }
          @if (needsAttention()) {
            <span class="attention-overlay-dot" [title]="activityLabel()"></span>
          } @else if (isHibernated()) {
            <span class="hibernated-overlay-dot" title="Hibernated — click to wake"></span>
          }
        </span>
      </span>

      <div class="instance-info">
        <div class="instance-name-row">
          @if (hasUnreadCompletion()) {
            <span class="unread-dot" title="Completed — click to view"></span>
          }
          @if (isAutomation()) {
            <span class="automation-clock" title="Started by a scheduled automation" aria-label="Automation session">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3.5 2" />
              </svg>
            </span>
          }
          <span class="instance-name">{{ resolvedDisplayTitle() }}</span>
          @if (hasPendingApproval()) {
            <span class="approval-chip" title="This instance has a pending permission request">Awaiting approval</span>
          }
          @if (hasChildren() && !isExpanded()) {
            <span class="collapsed-badge" title="Child instances (click arrow to expand)">+{{ resolvedChildCount() }}</span>
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
          [title]="supportsResume() ? 'Restart and resume conversation' : 'Restart with fresh context'"
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
  styleUrl: './instance-row.component.scss',
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
  childCount = input<number | null>(null);
  isExpanded = input<boolean>(false);
  isLastChild = input<boolean>(false);
  parentChain = input<boolean[]>([]);

  // Selection state
  isSelected = input<boolean>(false);
  lastActivityLabel = input<string | null>(null);

  // Drag state
  isDraggable = input<boolean>(false);

  /** True when this session has a non-terminal Loop Mode run (running or
   *  paused). Drives a distinct spinner ring so a looping session reads as
   *  busy in the rail even when the underlying CLI is briefly idle between
   *  iterations. */
  isLooping = input<boolean>(false);

  // Outputs
  instanceSelect = output<string>();
  terminate = output<string>();
  restart = output<string>();
  toggleExpand = output<string>();
  contextMenu = output<{ event: MouseEvent; instance: Instance; displayTitle: string }>();
  readonly resolvedDisplayTitle = computed(() => this.displayTitle()?.trim() || this.instance().displayName);
  readonly resolvedChildCount = computed(() => this.childCount() ?? this.instance().childrenIds.length);

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

  /**
   * True when this session was spawned by a scheduled automation. Detected via
   * durable instance metadata rather than the "Automation: …" displayName, which
   * AI auto-titling can overwrite. Drives the small clock indicator in the rail.
   */
  readonly isAutomation = computed(() => Boolean(this.instance().metadata?.['automationId']));

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
      case 'cursor':
        // Light neutral keeps Cursor's monochrome mark visible on dark surfaces.
        return { icon: 'cursor', color: '#E5E7EB', label: 'Cursor' } as const;
    }
  });
  readonly needsAttention = computed(() =>
    this.instance().status === 'waiting_for_input' ||
    this.instance().status === 'waiting_for_permission'
  );
  readonly showActivitySpinner = computed(() =>
    this.isLooping() ||
    this.instance().status === 'busy' ||
    this.instance().status === 'processing' ||
    this.instance().status === 'thinking_deeply' ||
    this.instance().status === 'initializing' ||
    this.instance().status === 'respawning' ||
    this.instance().status === 'interrupting' ||
    this.instance().status === 'cancelling' ||
    this.instance().status === 'interrupt-escalating' ||
    this.instance().status === 'waking' ||
    this.instance().status === 'hibernating'
  );
  readonly isHibernated = computed(() => this.instance().status === 'hibernated');
  readonly supportsResume = computed(() =>
    this.instance().provider === 'claude' || this.instance().provider === 'codex'
  );

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
    const base = this.statusActivityLabel();
    if (this.isLooping()) {
      // Surface the loop in the tooltip so the violet ring isn't a mystery.
      // When the underlying status also has a label (e.g. "Working"), append
      // it so we communicate both layers — "Loop running · Working".
      return base ? `Loop running · ${base}` : 'Loop running';
    }
    return base;
  });

  private readonly statusActivityLabel = computed(() => {
    switch (this.instance().status) {
      case 'busy':
        return 'Working';
      case 'initializing':
        return 'Initializing';
      case 'waiting_for_input':
        return 'Waiting for input';
      case 'waiting_for_permission':
        return 'Needs approval';
      case 'respawning':
        return 'Recovering session';
      case 'interrupting':
        return 'Interrupting';
      case 'cancelling':
        return 'Cancelling';
      case 'interrupt-escalating':
        return 'Escalating interrupt';
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

  onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenu.emit({
      event,
      instance: this.instance(),
      displayTitle: this.resolvedDisplayTitle(),
    });
  }
}
