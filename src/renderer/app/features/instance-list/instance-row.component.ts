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
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { isRemoteNodeOnline } from '../../core/state/remote-node-connectivity';

@Component({
  selector: 'app-instance-row',
  standalone: true,
  imports: [AioTooltipDirective],
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
        return { icon: 'github', color: '#B89A66', label: 'Copilot' } as const;
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

  /**
   * The badge's visible text must say the node is offline. Before this it showed
   * the node NAME in both states and signalled "disconnected — session may be
   * interrupted" through an amber class plus a hover tooltip only: colour alone
   * for a sighted user (WCAG 1.4.1), and nothing at all for a keyboard or
   * screen-reader user, who cannot reach a hover on a non-focusable span.
   */
  readonly remoteNodeBadgeLabel = computed(() =>
    (this.remoteNodeDisconnected() ? `${this.remoteNodeName()} · offline` : this.remoteNodeName()));

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

  /**
   * UX3 — the leading indicator is a coloured dot doing four jobs at once
   * (provider, activity, hibernated, looping). One structured string names all
   * of them, and doubles as the accessible name so the dot is never
   * colour-only (UX2.2 / G41).
   */
  readonly leadingIndicatorTooltip = computed(() => {
    const parts: string[] = [this.providerVisual().label];
    // `error` reaches none of the computeds below — `needsAttention`,
    // `showActivitySpinner` and `isHibernated` all exclude it — so before this
    // an errored instance was announced as just "Claude" and shown as an
    // 8%-opacity red row tint. Colour alone, for the one state a user most
    // needs to notice.
    if (this.instance().status === 'error') parts.push('error');
    else if (this.isHibernated()) parts.push('hibernated — send a message to wake');
    else if (this.needsAttention() || this.showActivitySpinner()) parts.push(this.activityLabel());
    return parts.filter(Boolean).join(' · ');
  });

  /**
   * The row's own accessible name. It carries the two states that otherwise
   * exist only as a CSS tint, so a screen-reader user learns them on landing
   * rather than by hovering something they cannot hover:
   *  - `error`, previously an 8%-opacity red background and nothing else;
   *  - `yoloMode`, previously a 14%-opacity inset border and nothing else —
   *    and it means tool calls run without asking, which is exactly the kind of
   *    thing a user should not have to infer from a border tint.
   */
  readonly rowAriaLabel = computed(() => {
    const states: string[] = [];
    if (this.instance().status === 'error') states.push('error');
    if (this.instance().yoloMode) states.push('auto-approve mode');
    const suffix = states.length > 0 ? ` — ${states.join(', ')}` : '';
    return `Select instance ${this.resolvedDisplayTitle()}${suffix}`;
  });

  /** UX3: the tooltip and the accessible name are one string. */
  readonly expandTooltip = computed(() =>
    `${this.isExpanded() ? 'Collapse' : 'Expand'} child instances`);

  readonly restartTooltip = computed(() => this.supportsResume()
    ? 'Restart and resume the conversation'
    : 'Restart with fresh context — the conversation so far is not carried over');

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
