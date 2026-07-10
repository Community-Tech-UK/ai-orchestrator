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
import { isRemoteNodeOnline } from '../../core/state/remote-node-connectivity';

@Component({
  selector: 'app-instance-row',
  standalone: true,
  imports: [],
  templateUrl: './instance-row.component.html',
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
      case 'antigravity':
        return { icon: 'google', color: '#00B8D4', label: 'Antigravity' } as const;
      case 'copilot':
        return { icon: 'github', color: '#6e40c9', label: 'Copilot' } as const;
      case 'ollama':
        return { icon: 'ollama', color: '#7dd3fc', label: 'Ollama' } as const;
      case 'cursor':
        // Light neutral keeps Cursor's monochrome mark visible on dark surfaces.
        return { icon: 'cursor', color: '#E5E7EB', label: 'Cursor' } as const;
      case 'grok':
        return { icon: 'grok', color: '#1DA1F2', label: 'Grok' } as const;
      default:
        return { icon: 'default', color: '#9CA3AF', label: 'Provider' } as const;
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
    return !node || !isRemoteNodeOnline(node);
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
