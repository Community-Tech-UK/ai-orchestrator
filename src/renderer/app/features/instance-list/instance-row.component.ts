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
import { Instance, InstanceStore } from '../../core/state/instance.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { ToolLoopAlertStore } from '../../core/state/tool-loop-alert.store';
import { isRemoteNodeOnline } from '../../core/state/remote-node-connectivity';
import { SideChatStore } from '../../core/state/side-chat.store';
import { SessionHoverDetailsComponent } from './session-hover-details.component';
import type { SideChatParentRef } from '../../../../shared/types/side-chat.types';
import { sideChatRowBadge } from '../side-chat/side-chat-badge';
import { computerName, providerName } from '../../../../shared/display-names';
import {
  describeInstanceStatus,
  presentInstanceStatus,
} from '../../../../shared/attention/instance-status-presentation';

@Component({
  selector: 'app-instance-row',
  standalone: true,
  imports: [AioTooltipDirective, SessionHoverDetailsComponent],
  templateUrl: './instance-row.component.html',
  styleUrl: './instance-row.component.scss',
  styles: ['.activity-line { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 11px; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InstanceRowComponent {
  private readonly instances = inject(InstanceStore);
  private readonly remoteNodeStore = inject(RemoteNodeStore);
  private readonly toolLoopAlerts = inject(ToolLoopAlertStore);
  private readonly sideChatStore = inject(SideChatStore);

  // Required inputs
  instance = input.required<Instance>();
  displayTitle = input<string | null>(null);

  // Hierarchy inputs
  depth = input<number>(0);
  hasChildren = input<boolean>(false);
  childCount = input<number | null>(null);
  descendantNeedsYou = input(0);
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

  /** The chip beside a pending permission request reads like the status that asks for it. */
  readonly approvalChipLabel = computed(() => presentInstanceStatus(
    this.instance().status === 'waiting_for_input' ? 'waiting_for_input' : 'waiting_for_permission').label);
  /** A question is never called an approval: the chip says which of the two is waiting. */
  readonly approvalChipTooltip = computed(() => this.instance().status === 'waiting_for_input'
    ? 'This session has a question waiting for your answer' : 'This session is waiting for you to approve something');

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

  private readonly sideChatParent = computed<SideChatParentRef>(() => ({
    kind: 'session',
    historyThreadId: this.instance().historyThreadId,
    originNodeId: this.instance().workerNodeId ?? null,
  }));

  /**
   * This session's sidechat activity, so answers stay discoverable with the
   * panel closed. Needing action outranks unread, which outranks running.
   */
  readonly sideChatBadge = computed(() =>
    sideChatRowBadge(this.sideChatStore.attentionFor(this.sideChatParent())));

  openSideChats(event: Event): void {
    event.stopPropagation();
    const attention = this.sideChatStore.attentionFor(this.sideChatParent());
    this.sideChatStore.requestOpen(this.sideChatParent(), attention?.targetChatId ?? null);
  }

  /**
   * True when this session was spawned by a scheduled automation. Detected via
   * durable instance metadata rather than the "Automation: …" displayName, which
   * AI auto-titling can overwrite. Drives the small clock indicator in the rail.
   */
  readonly isAutomation = computed(() => Boolean(this.instance().metadata?.['automationId']));

  /**
   * True when this session was spawned by the Plan Queue coordinator as a
   * triage, worker, or verifier instance. Detected via durable instance
   * metadata, the same mechanism `isAutomation` uses. Drives a small
   * provenance marker in the rail so a Plan Queue session reads as such
   * alongside the automation clock indicator.
   */
  readonly planQueueRole = computed(() => {
    const role = this.instance().metadata?.['planQueueRole'];
    return role === 'worker' || role === 'verifier' || role === 'triage' ? role : null;
  });

  readonly planQueueRoleLabel = computed(() => {
    switch (this.planQueueRole()) {
      case 'worker':
        return 'Plan Queue worker';
      case 'verifier':
        return 'Plan Queue verifier';
      case 'triage':
        return 'Plan Queue triage';
      default:
        return '';
    }
  });

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
    const { provider, currentModel } = this.instance();
    // OpenCode reads "MiMo" only when the session's model proves it is the MiMo plan.
    const label = providerName(provider, { model: currentModel });
    switch (provider) {
      case 'claude':
        return { icon: 'anthropic', color: '#D97706', label } as const;
      case 'codex':
        return { icon: 'openai', color: '#10A37F', label } as const;
      case 'gemini':
        return { icon: 'google', color: '#4285F4', label } as const;
      case 'antigravity':
        return { icon: 'google', color: '#00B8D4', label } as const;
      case 'copilot':
        return { icon: 'github', color: '#B89A66', label } as const;
      case 'ollama':
        return { icon: 'ollama', color: '#7dd3fc', label } as const;
      case 'cursor':
        // Light neutral keeps Cursor's monochrome mark visible on dark surfaces.
        return { icon: 'cursor', color: '#E5E7EB', label } as const;
      case 'grok':
        return { icon: 'grok', color: '#1DA1F2', label } as const;
      case 'opencode':
        return { icon: 'opencode', color: '#D4D4D8', label } as const;
      default:
        return { icon: 'default', color: '#9CA3AF', label } as const;
    }
  });

  /** Words, colour and dot behaviour for the session's status come from the one status presenter. */
  private readonly statusPresentation = computed(() => {
    const { status, waitReason } = this.instance();
    return presentInstanceStatus(status, waitReason);
  });
  /**
   * N2 — a critical tool loop wants a person as much as a blocked prompt does,
   * and it happens mid-turn, so the two prior statuses could never show it: the
   * session looks busy, which is exactly what a loop looks like from outside.
   */
  readonly hasToolLoopAlert = computed(() =>
    this.toolLoopAlerts.hasCriticalAlert(this.instance().id));

  readonly needsAttention = computed(() =>
    this.statusPresentation().needsYou || this.hasToolLoopAlert()
  );
  readonly showActivitySpinner = computed(() =>
    this.isLooping() || this.statusPresentation().inProgress
  );
  readonly isHibernated = computed(() => this.instance().status === 'hibernated');
  /**
   * Idle between turns, but the provider still owns a background shell or
   * agent. Not finished, not busy, and not waiting on the user, so it gets its
   * own indicator rather than borrowing the spinner or the amber dot.
   */
  readonly isWaitingOnBackgroundWork = computed(() => {
    const { status, backgroundWork } = this.instance();
    return (backgroundWork?.count ?? 0) > 0
      && (status === 'idle' || status === 'ready')
      && !this.showActivitySpinner()
      && !this.needsAttention();
  });
  private readonly backgroundWorkLabel = computed(() => {
    const work = this.instance().backgroundWork;
    if (!work) return '';
    const tasks = work.count === 1 ? '1 background task' : `${work.count} background tasks`;
    const since = new Date(work.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `Waiting on ${tasks} (since ${since})`;
  });
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

  /** The computer's own name, or a plain description when it has none. Never a raw node id. */
  readonly remoteNodeName = computed(() => {
    const nodeId = this.remoteNodeId();
    if (!nodeId) return '';
    const node = this.remoteNodeStore.nodeById(nodeId);
    return computerName({ name: node?.name, platform: node?.platform });
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
      ? `${name} is offline — this session may be interrupted`
      : `Running on ${name}`;
  });

  readonly activityLabel = computed(() => {
    const base = this.statusActivityLabel();
    if (this.hasToolLoopAlert()) {
      // Leads, because it is the reason the row is asking for attention. The
      // underlying status ("Working") is true and actively misleading on its
      // own here — a looping session looks busy.
      return base ? `Tool loop detected · ${base}` : 'Tool loop detected';
    }
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
    // A problem reaches none of the computeds below — `needsAttention`,
    // `showActivitySpinner` and `isHibernated` all exclude it — so before this
    // an errored instance was announced as just "Claude" and shown as an
    // 8%-opacity red row tint. Colour alone, for the one state a user most
    // needs to notice.
    // A session that is asleep or parked on a usage limit looks idle by status,
    // so the presenter's wait-aware words are what tell the two apart.
    const presentation = this.statusPresentation();
    const settledAsleep = presentation.label === 'Asleep' && !presentation.inProgress;
    if (presentation.label === 'Problem' || settledAsleep) parts.push(describeInstanceStatus(presentation));
    else if (this.needsAttention() || this.showActivitySpinner()) parts.push(this.activityLabel());
    else if (this.isWaitingOnBackgroundWork()) parts.push(this.backgroundWorkLabel());
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
  readonly activityLine = computed(() => ['busy', 'processing', 'thinking_deeply'].includes(this.instance().status)
    ? this.instances.liveActivities().get(this.instance().id) ?? null : null);

  readonly rowAriaLabel = computed(() => {
    const states: string[] = [];
    if (this.statusPresentation().label === 'Problem') states.push('problem');
    if (this.instance().yoloMode) states.push('auto-approve mode');
    if (this.activityLine()) states.push(this.activityLine()!);
    const suffix = states.length > 0 ? ` — ${states.join(', ')}` : '';
    return `Select session ${this.resolvedDisplayTitle()}${suffix}`;
  });

  /** UX3: the tooltip and the accessible name are one string. */
  readonly expandTooltip = computed(() =>
    `${this.isExpanded() ? 'Collapse' : 'Expand'} child sessions`);

  /**
   * Only a root session is archived on close (`archiveRootConversation()` bails
   * on `parentId`), and this same row template renders every child in the tree,
   * so the history half of the sentence has to be earned per row.
   */
  readonly closeTooltip = computed(() => this.instance().parentId
    ? 'Close session — stops this child agent and removes it from the tree'
    : 'Close session — stops the agent and moves this session to history');

  readonly restartTooltip = computed(() => this.supportsResume()
    ? 'Restart and resume the conversation'
    : 'Restart with fresh context — the conversation so far is not carried over');

  /** Said only while the session is doing something or waiting on you; a settled row stays quiet. */
  private readonly statusActivityLabel = computed(() => {
    const presentation = this.statusPresentation();
    return presentation.inProgress || presentation.needsYou ? describeInstanceStatus(presentation) : '';
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
