/**
 * Output Stream Component - Displays Claude's output messages with rich markdown rendering
 *
 * Groups consecutive assistant "thinking" messages into a collapsible section,
 * similar to claude.ai's "Thought process" UI.
 */

import {
  Component,
  input,
  computed,
  output,
  viewChild,
  effect,
  inject,
  signal,
  ChangeDetectionStrategy,
  afterNextRender,
  DestroyRef,
  ElementRef
} from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { OutputMessage } from '../../core/state/instance.store';
import type { FailedImageRef, FileAttachment } from '../../../../shared/types/instance.types';
import { MarkdownService } from '../../core/services/markdown.service';
import { ElectronIpcService, InstanceIpcService } from '../../core/services/ipc';
import { InstanceOutputStore } from '../../core/state/instance/instance-output.store';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { MessageAttachmentsComponent } from '../../shared/components/message-attachments/message-attachments.component';
import { FailedImageCardComponent } from '../../shared/components/failed-image-card/failed-image-card.component';
import { SystemEventGroupComponent } from '../../shared/components/system-event-group/system-event-group.component';
import { ThoughtProcessComponent } from '../../shared/components/thought-process/thought-process.component';
import { ToolGroupComponent } from '../../shared/components/tool-group/tool-group.component';
import { DisplayItemProcessor, DisplayItem } from './display-item-processor.service';
import { ExpansionStateService } from './expansion-state.service';
import { ContextMenuComponent, ContextMenuItem } from '../../shared/components/context-menu/context-menu.component';
import { InstanceStore } from '../../core/state/instance/instance.store';
import { MessageFormatService } from './message-format.service';
import { OutputScrollService } from './output-scroll.service';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import type { LinkKind } from '../../../../shared/utils/link-detection';
import { shouldCollapseUserMessage } from './output-stream-message-collapse';

type RenderedMarkdown = ReturnType<MarkdownService['render']>;

/** Narrows DisplayItem's `unknown` rendered fields to RenderedMarkdown for template type safety */
interface RenderedDisplayItem extends DisplayItem {
  renderedMessage?: RenderedMarkdown;
  renderedResponse?: RenderedMarkdown;
}

interface LinkedFileTarget {
  rawPath: string;
  resolvedPath: string;
  displayPath: string;
  canUseLocalFileActions: boolean;
}

@Component({
  selector: 'app-output-stream',
  standalone: true,
  imports: [
    DatePipe,
    NgTemplateOutlet,
    MessageAttachmentsComponent,
    FailedImageCardComponent,
    SystemEventGroupComponent,
    ThoughtProcessComponent,
    ToolGroupComponent,
    ContextMenuComponent,
  ],
  templateUrl: './output-stream.component.html',
  styleUrl: './output-stream.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OutputStreamComponent {
  messages = input.required<OutputMessage[]>();
  instanceId = input.required<string>();
  provider = input<string>('claude');
  showThinking = input<boolean>(true);
  thinkingDefaultExpanded = input<boolean>(false);
  showToolMessages = input<boolean>(true);
  isChild = input<boolean>(false);

  /** Emitted when the user clicks the edit button on the last user message. */
  editMessage = output<void>();

  /** ID of the last user message — used to show the edit button only on that message. */
  protected lastUserMessageId = computed(() => {
    const msgs = this.messages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].type === 'user') return msgs[i].id;
    }
    return null;
  });

  container = viewChild<ElementRef<HTMLDivElement>>('container');

  /** Whether tool call groups are visible in the stream. Defaults to hidden for child instances. */
  showToolCalls = signal<boolean | null>(null); // null = use isChild default

  // Scroll state - stored per instance
  protected showScrollToTop = signal(false);
  protected showScrollToBottom = signal(false);
  /** Boxed boolean so OutputScrollService can mutate it by reference */
  private userScrolledUpRef = { value: false };
  /**
   * Boxed boolean that tells OutputScrollService's listener to short-circuit
   * while we are mid-switch. Without this, the auto-clamp scroll event the
   * browser fires when switching to a session with shorter content overwrites
   * scrollPositions[currentInstanceId] before our rAF restore can read it.
   */
  private isRestoringRef = { value: false };
  private scrollPositions = new Map<string, number>(); // instanceId -> scrollOffset
  private previousInstanceId: string | null = null;
  /**
   * If a switch fires while the new instance's outputBuffer is empty, the
   * `#container` div doesn't exist yet (the template renders an empty-stream
   * placeholder instead) and the rAF restore is a no-op. We park the intended
   * restore here; a watcher effect on `container()` completes it once the
   * container materialises.
   */
  private pendingRestore: { instanceId: string; targetPosition: number | undefined } | null = null;
  private lastAutoScrollInstanceId: string | null = null;
  private lastAutoScrollSignature = '';

  protected copiedMessageId = signal<string | null>(null);
  protected expandedUserMessageIds = signal(new Set<string>());
  private copyResetTimer: number | null = null;

  // Context menu state
  protected contextMenuVisible = signal(false);
  protected contextMenuX = signal(0);
  protected contextMenuY = signal(0);
  protected contextMenuItems = signal<ContextMenuItem[]>([]);

  // Load-more state
  protected isLoadingOlder = signal(false);
  protected hasOlderMessages = signal(false); // Hidden until backend confirms stored transcript exists
  private olderMessagesHiddenCount = signal(0);
  private oldestChunkLoaded = new Map<string, number>(); // instanceId -> oldest chunk index

  private markdownService = inject(MarkdownService);
  private ipc = inject(ElectronIpcService);
  private instanceIpc = inject(InstanceIpcService);
  private outputStore = inject(InstanceOutputStore);
  private instanceStore = inject(InstanceStore);
  private perf = inject(PerfInstrumentationService);
  private destroyRef = inject(DestroyRef);
  private expansionState = inject(ExpansionStateService);
  private messageFormat = inject(MessageFormatService);
  private scrollService = inject(OutputScrollService);
  private clipboard = inject(CLIPBOARD_SERVICE);
  private fileIpc = inject(FileIpcService);
  private displayItemProcessor = new DisplayItemProcessor();

  /**
   * Shows all messages, consolidating streaming messages with the same ID.
   * Streaming messages (from Copilot SDK) have metadata.streaming=true and share the same ID.
   * We display only the accumulated content for streaming messages.
   */
  displayItems = computed<RenderedDisplayItem[]>(() => {
    const startTime = performance.now();
    const messages = this.messages();
    const instanceId = this.instanceId();
    const historyOffset = this.olderMessagesHiddenCount();

    const items = this.displayItemProcessor.process(messages, instanceId, historyOffset);

    // Incremental markdown rendering: only render new items.
    // Iterate the processor's flat list (not the returned wrapped view) because
    // work-cycle containers don't own markdown directly — their children do,
    // and work-cycles share child object references with the flat list.
    // Clamp startIdx to 0 defensively against stale counters after a reset.
    const newCount = this.displayItemProcessor.newItemCount;
    if (newCount > 0) {
      const flat = this.displayItemProcessor.flatItems;
      const startIdx = Math.max(0, flat.length - newCount);
      for (let i = startIdx; i < flat.length; i++) {
        this.renderItemMarkdown(flat[i]);
      }
    }

    const duration = performance.now() - startTime;
    this.perf.recordDisplayItemsCompute(messages.length, items.length, duration);

    // Safe cast: renderItemMarkdown() populates renderedMessage/renderedResponse with RenderedMarkdown
    return items as RenderedDisplayItem[];
  });

  /** Whether tool calls are effectively shown.
   *  Priority: local toggle > global setting > default (hide for children). */
  protected effectiveShowToolCalls = computed(() => {
    // Local per-instance toggle takes highest priority
    const explicit = this.showToolCalls();
    if (explicit !== null) return explicit;
    // Global setting from display preferences
    if (!this.showToolMessages()) return false;
    // Default: show for parents, hide for children
    return !this.isChild();
  });

  /** Display items filtered by tool call visibility. When tool calls are hidden
   *  we also strip them from work-cycle children so collapsed cycles don't
   *  silently contain invisible entries. */
  protected visibleItems = computed<RenderedDisplayItem[]>(() => {
    const items = this.displayItems();
    if (this.effectiveShowToolCalls()) return items;
    const result: RenderedDisplayItem[] = [];
    for (const item of items) {
      if (item.type === 'tool-group') continue;
      if (item.type === 'work-cycle' && item.children) {
        const filtered = item.children.filter(c => c.type !== 'tool-group');
        if (filtered.length === 0) continue;
        result.push({ ...item, children: filtered });
      } else {
        result.push(item);
      }
    }
    return result;
  });

  /** Count of hidden tool-group items (for the toggle bar), including those
   *  nested inside work-cycles. */
  protected hiddenToolGroupCount = computed(() => {
    if (this.effectiveShowToolCalls()) return 0;
    let count = 0;
    for (const item of this.displayItems()) {
      if (item.type === 'tool-group') count++;
      else if (item.type === 'work-cycle' && item.children) {
        for (const child of item.children) if (child.type === 'tool-group') count++;
      }
    }
    return count;
  });

  constructor() {
    // Handle instance changes - restore scroll position for the new instance.
    //
    // We do NOT save the previous instance's scrollTop here. The scroll
    // listener (OutputScrollService) already keeps scrollPositions up to date
    // on every real user scroll, so previousInstanceId's value is already
    // correctly cached by the time a switch fires. Saving it again here would
    // read viewport.scrollTop AFTER Angular has rendered the new instance's
    // (potentially shorter) content — at that point the browser has
    // auto-clamped scrollTop, so we'd overwrite the correct saved value with a
    // clamped one. That was bug #1 of the cross-session scroll issue.
    effect(() => {
      const currentInstanceId = this.instanceId();
      if (currentInstanceId === this.previousInstanceId) {
        return;
      }

      // Snapshot the saved scroll for the new instance SYNCHRONOUSLY, before
      // any scroll events get a chance to corrupt it. Per the HTML rendering
      // pipeline, scroll-step events fire BEFORE rAF callbacks in the same
      // frame, so reading scrollPositions inside rAF would otherwise see a
      // value that the listener overwrote with the auto-clamped scrollTop.
      // (We also raise isRestoringRef below so the listener short-circuits
      // anyway — this snapshot is the second line of defense.)
      const targetPosition = this.scrollPositions.get(currentInstanceId);

      // Reset per-instance scroll state
      this.userScrolledUpRef.value = false;
      this.showScrollToTop.set(false);
      this.showScrollToBottom.set(false);
      this.hasOlderMessages.set(false);
      this.isLoadingOlder.set(false);
      this.olderMessagesHiddenCount.set(0);
      this.lastAutoScrollInstanceId = currentInstanceId;
      this.lastAutoScrollSignature = this.getMessageSignature(this.messages());
      // Drop any deferred restore from a prior switch — it's stale now.
      this.pendingRestore = null;

      // Suppress listener writes until the rAF restore completes, so that
      // browser auto-clamp scroll events cannot corrupt scrollPositions
      // for currentInstanceId before we set scrollTop ourselves.
      this.isRestoringRef.value = true;

      // Perf: measure thread switch time and transcript paint
      const stopSwitch = this.perf.markThreadSwitch(this.previousInstanceId, currentInstanceId);
      const stopPaint = this.perf.markTranscriptPaint(currentInstanceId, this.messages().length);

      // Restore scroll position for the new instance using rAF for frame alignment
      requestAnimationFrame(() => {
        // If the user has switched away again before this frame landed, abort.
        if (this.instanceId() !== currentInstanceId) {
          this.isRestoringRef.value = false;
          stopPaint();
          stopSwitch();
          return;
        }
        const nextViewport = this.getViewportElement();
        if (nextViewport) {
          this.applyScrollRestore(nextViewport, targetPosition);
        } else {
          // Container isn't in the DOM yet — most likely the new instance's
          // outputBuffer is empty and Angular is rendering the empty-stream
          // placeholder via `@if (displayItems().length === 0)`. Park the
          // intended restore; the watcher effect below will complete it once
          // the container appears (e.g. when history hydrates).
          this.pendingRestore = { instanceId: currentInstanceId, targetPosition };
        }
        // Clear the guard last. Programmatically setting scrollTop above
        // queues a scroll event for the NEXT frame; by then the listener is
        // un-gated, so it'll naturally re-record scrollPositions for the new
        // instance with the restored value. (If we deferred, the watcher
        // effect re-raises this guard before its own rAF.)
        this.isRestoringRef.value = false;
        stopPaint();
        stopSwitch();
      });

      this.previousInstanceId = currentInstanceId;

      // Probe backend to check if stored transcript exists for this instance
      this.probeForOlderMessages(currentInstanceId);
    });

    // Deferred-restore watcher.
    //
    // Runs whenever the `container` viewChild signal or the current
    // instanceId changes. If we have a parked restore for the current
    // instance and the container has now materialised, complete the restore.
    // This covers the case where the user switches to a session whose
    // outputBuffer hadn't hydrated yet — without this, scroll would land at
    // 0 once messages arrived.
    effect(() => {
      const containerRef = this.container();
      const currentId = this.instanceId();
      const pending = this.pendingRestore;
      if (!containerRef || !pending || pending.instanceId !== currentId) {
        return;
      }

      const targetPosition = pending.targetPosition;
      this.pendingRestore = null;

      // If we're restoring to a non-bottom position, mark the user as
      // scrolled-up *before* the auto-scroll effect's rAF runs, so it skips
      // its scroll-to-bottom and we don't briefly bounce to the bottom
      // before our restore overrides.
      if (targetPosition !== undefined) {
        this.userScrolledUpRef.value = true;
      }

      this.isRestoringRef.value = true;

      requestAnimationFrame(() => {
        // Bail out if a later instance switch has invalidated this restore.
        if (this.instanceId() !== currentId) {
          this.isRestoringRef.value = false;
          return;
        }
        const viewport = this.getViewportElement();
        if (viewport) {
          this.applyScrollRestore(viewport, targetPosition);
        }
        this.isRestoringRef.value = false;
      });
    });

    // Auto-scroll to bottom when new messages arrive (only if user hasn't scrolled up)
    effect(() => {
      const currentInstanceId = this.instanceId();
      const msgs = this.messages();
      const signature = this.getMessageSignature(msgs);
      const previousInstanceId = this.lastAutoScrollInstanceId;
      const previousSignature = this.lastAutoScrollSignature;

      this.lastAutoScrollInstanceId = currentInstanceId;
      this.lastAutoScrollSignature = signature;

      if (!msgs.length || previousInstanceId !== currentInstanceId || previousSignature === signature) {
        return;
      }

      requestAnimationFrame(() => {
        const viewport = this.getViewportElement();
        if (viewport && !this.userScrolledUpRef.value) {
          viewport.scrollTop = viewport.scrollHeight;
        }
      });
    });

    // Deferred syntax highlighting: after Angular renders new content,
    // highlight code blocks in idle time so input is never blocked.
    effect(() => {
      this.visibleItems();
      setTimeout(() => {
        const container = this.getViewportElement();
        if (container) {
          this.markdownService.highlightCodeBlocksInElement(container);
        }
      });
    });

    // Setup scroll listener and delegated click handler after render
    afterNextRender(() => {
      const clickBinding = this.setupDelegatedClickHandler();
      const scrollBinding = this.setupScrollListener();

      this.destroyRef.onDestroy(() => {
        if (clickBinding) {
          clickBinding.element.removeEventListener('click', clickBinding.listener);
        }
        if (scrollBinding) {
          scrollBinding.element.removeEventListener('scroll', scrollBinding.listener);
        }

        if (this.copyResetTimer !== null) {
          clearTimeout(this.copyResetTimer);
          this.copyResetTimer = null;
        }
      });
    });
  }

  /**
   * Apply a captured scroll-restore to a viewport. Either snaps to
   * `targetPosition` (when we have a saved scroll for this instance) or
   * scrolls to the bottom (the default for never-visited instances).
   * Also updates the scroll-button visibility signals to match.
   */
  private applyScrollRestore(viewport: HTMLElement, targetPosition: number | undefined): void {
    if (targetPosition !== undefined) {
      viewport.scrollTop = targetPosition;
      const distanceFromBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      this.userScrolledUpRef.value = distanceFromBottom > 100;
      this.showScrollToTop.set(targetPosition > 50);
      this.showScrollToBottom.set(distanceFromBottom > 50);
    } else {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }

  /**
   * Setup scroll event listener to detect user scrolling.
   * Returns the element and bound listener so the caller can remove it on destroy.
   * Delegates to OutputScrollService.
   */
  private setupScrollListener(): { element: HTMLElement; listener: EventListener } | null {
    const el = this.getViewportElement();
    if (!el) return null;
    return this.scrollService.setupScrollListener(
      el,
      {
        showScrollToTop: this.showScrollToTop,
        showScrollToBottom: this.showScrollToBottom,
        scrollPositions: this.scrollPositions,
        userScrolledUp: this.userScrolledUpRef,
        isRestoring: this.isRestoringRef,
      },
      () => this.instanceId(),
      () => this.messages(),
      () => this.isLoadingOlder(),
      () => this.hasOlderMessages(),
      () => { void this.loadOlderMessages(); },
    );
  }

  /**
   * Load older messages from disk storage
   */
  async loadOlderMessages(): Promise<void> {
    if (this.isLoadingOlder() || !this.hasOlderMessages()) return;

    const instanceId = this.instanceId();
    this.isLoadingOlder.set(true);

    try {
      const beforeChunk = this.oldestChunkLoaded.get(instanceId);
      const result = await this.instanceIpc.loadOlderMessages(instanceId, {
        beforeChunk,
        limit: 200,
      });

      if (result.success && result.data) {
        const data = result.data as {
          messages: OutputMessage[];
          hasMore: boolean;
          oldestChunkLoaded?: number;
          totalStored: number;
        };

        if (data.messages.length > 0) {
          const existingIds = new Set(this.messages().map(message => message.id));
          const prependedCount = data.messages.filter(message => !existingIds.has(message.id)).length;

          // Remember scroll height before prepend to maintain position
          const viewport = this.getViewportElement();
          const scrollHeightBefore = viewport?.scrollHeight ?? 0;

          this.outputStore.prependOlderMessages(instanceId, data.messages);
          if (prependedCount > 0) {
            this.olderMessagesHiddenCount.update((count) => Math.max(0, count - prependedCount));
          }

          // After Angular renders the new items, restore scroll position
          requestAnimationFrame(() => {
            if (viewport) {
              const scrollHeightAfter = viewport.scrollHeight;
              viewport.scrollTop += scrollHeightAfter - scrollHeightBefore;
            }
          });
        }

        this.hasOlderMessages.set(data.hasMore);
        if (data.oldestChunkLoaded !== undefined) {
          this.oldestChunkLoaded.set(instanceId, data.oldestChunkLoaded);
        }
      } else {
        this.hasOlderMessages.set(false);
      }
    } catch (error) {
      console.error('[OutputStream] Failed to load older messages:', error);
    } finally {
      this.isLoadingOlder.set(false);
    }
  }

  /**
   * Lightweight probe: check if stored transcript exists without loading messages.
   * Sets hasOlderMessages based on backend response.
   */
  private async probeForOlderMessages(instanceId: string): Promise<void> {
    try {
      const result = await this.instanceIpc.loadOlderMessages(instanceId, {
        beforeChunk: undefined,
        limit: 1,
      });
      if (result.success && result.data) {
        const data = result.data as { messages: OutputMessage[]; hasMore: boolean; totalStored: number };
        this.hasOlderMessages.set(data.totalStored > 0);
        this.olderMessagesHiddenCount.set(data.totalStored);
      }
    } catch {
      // Silently fail — button stays hidden
    }
  }

  /**
   * Scroll to the top of the container
   */
  toggleToolCalls(): void {
    const current = this.effectiveShowToolCalls();
    this.showToolCalls.set(!current);
  }

  scrollToTop(): void {
    const el = this.getViewportElement();
    if (!el) return;
    this.scrollService.scrollToTop(el, { showScrollToTop: this.showScrollToTop });
  }

  /**
   * Scroll to the bottom of the container
   */
  scrollToBottom(): void {
    const el = this.getViewportElement();
    if (!el) return;
    this.scrollService.scrollToBottom(el, {
      showScrollToBottom: this.showScrollToBottom,
      userScrolledUp: this.userScrolledUpRef,
    });
  }

  /**
   * Setup a single delegated click handler on the container for copy buttons and file paths.
   * This replaces per-element querySelectorAll scanning that ran every 100ms.
   * Returns the element and bound listener so the caller can remove it on destroy.
   */
  private setupDelegatedClickHandler(): { element: HTMLElement; listener: EventListener } | null {
    const el = this.getViewportElement();
    if (!el) return null;

    const listener: EventListener = (event: Event) => {
      const mouseEvent = event as MouseEvent;
      const target = mouseEvent.target as HTMLElement;

      // Check for copy button clicks (walk up to find button with data-copy-id)
      const copyButton = target.closest('[data-copy-id]') as HTMLElement | null;
      if (copyButton) {
        const copyId = copyButton.getAttribute('data-copy-id');
        if (copyId) {
          this.markdownService.handleCopyClick(copyId);
        }
        return;
      }

      const linkTarget = target.closest('[data-file-path], [data-link-kind]') as HTMLElement | null;
      const linkKind = linkTarget ? this.classifyLinkTarget(linkTarget) : null;
      if (linkKind === 'file-path' && linkTarget) {
        mouseEvent.preventDefault();
        mouseEvent.stopPropagation();
        const filePath = linkTarget.getAttribute('data-file-path');
        if (filePath) {
          this.onFilePathClick(filePath);
        }
      }
    };

    el.addEventListener('click', listener);
    return { element: el, listener };
  }

  private classifyLinkTarget(target: HTMLElement): LinkKind | null {
    if (target.hasAttribute('data-file-path')) {
      return 'file-path';
    }
    if (target.dataset['linkKind'] === 'url') {
      return 'url';
    }
    if (target.dataset['linkKind'] === 'error-trace') {
      return 'error-trace';
    }
    return null;
  }

  /**
   * Handle click on a file path - open the file with the system default app.
   */
  private onFilePathClick(filePath: string): void {
    const target = this.buildLinkedFileTarget(filePath);
    if (!target.canUseLocalFileActions) {
      return;
    }
    void this.fileIpc.openPath(target.resolvedPath);
  }

  /**
   * Copy message content to clipboard.
   *
   * If the message has image attachments, copies them alongside the text as
   * a multi-format clipboard entry (plain text + HTML with inline images +
   * first image as a native image). Otherwise falls back to a text-only copy.
   */
  async copyMessageContent(
    content: string,
    messageId: string,
    attachments?: FileAttachment[],
  ): Promise<void> {
    const imageAttachments = (attachments ?? []).filter(
      (a) => typeof a.data === 'string' && a.type.startsWith('image/'),
    );

    if (!content && imageAttachments.length === 0) return;

    const result = await this.clipboard.copyMessage(
      {
        text: content,
        images: imageAttachments.map((a) => ({ dataUrl: a.data, name: a.name })),
      },
      { silent: true, label: 'message' },
    );

    if (result.ok) {
      this.copiedMessageId.set(messageId);
      if (this.copyResetTimer) {
        window.clearTimeout(this.copyResetTimer);
      }
      this.copyResetTimer = window.setTimeout(() => {
        this.copiedMessageId.set(null);
      }, 2000);
    } else {
      console.error('Failed to copy message:', result.reason, result.cause);
    }
  }

  isMessageCopied(messageId: string): boolean {
    return this.copiedMessageId() === messageId;
  }

  isCycleExpanded(itemId: string): boolean {
    return this.expansionState.isExpanded(this.instanceId(), itemId);
  }

  toggleCycle(itemId: string): void {
    this.expansionState.toggleExpanded(this.instanceId(), itemId);
  }

  // ---- Formatting delegates (logic lives in MessageFormatService) ----

  /** Summary shown on a collapsed work-cycle header. */
  summarizeCycle(item: DisplayItem): string {
    return this.messageFormat.summarizeCycle(item);
  }

  /** "23s" / "2m 15s" elapsed across the cycle's children; empty if unknown. */
  formatCycleDuration(item: DisplayItem): string {
    return this.messageFormat.formatCycleDuration(item);
  }

  formatType(type: string, provider: string): string {
    return this.messageFormat.formatType(type, provider);
  }

  protected getProviderDisplayName(provider: string): string {
    return this.messageFormat.getProviderDisplayName(provider);
  }

  hasContent(message: OutputMessage): boolean {
    return this.messageFormat.hasContent(message);
  }

  isCompactionBoundary(message: OutputMessage): boolean {
    return this.messageFormat.isCompactionBoundary(message);
  }

  isRestoreNotice(message: OutputMessage): boolean {
    return this.messageFormat.isRestoreNotice(message);
  }

  getCompactionLabel(message: OutputMessage): string {
    return this.messageFormat.getCompactionLabel(message);
  }

  formatCompactionReason(reason: string): string {
    return this.messageFormat.formatCompactionReason(reason);
  }

  formatCompactionFallbackMode(mode: string): string {
    return this.messageFormat.formatCompactionFallbackMode(mode);
  }

  /** Returns false if thinking is hidden AND response is empty. */
  hasThoughtGroupContent(item: DisplayItem, showThinking: boolean): boolean {
    return this.messageFormat.hasThoughtGroupContent(item, showThinking);
  }

  getToolName(message: OutputMessage): string {
    return this.messageFormat.getToolName(message);
  }

  formatContent(message: OutputMessage): string {
    return this.messageFormat.formatContent(message);
  }

  /**
   * Filter the failed-image-card list shown under a message.
   *
   * `unsupported` failures from bare-URL inference (a URL that happens to
   * end in `.png` etc. on its own line) are suppressed: the inference is
   * best-effort, and showing a red error card for every such miss creates
   * UI noise. Explicit `![](url)` markdown image failures are always
   * surfaced — those represent a deliberate intent from the model that
   * the user should see when it goes wrong.
   *
   * Older persisted messages may not carry `origin`; treat missing
   * origin as `markdown` (the conservative choice — keep it visible).
   */
  protected visibleFailedImages(failures: readonly FailedImageRef[]): FailedImageRef[] {
    return failures.filter((failure) => {
      if (failure.reason !== 'unsupported') return true;
      return failure.origin !== 'bare';
    });
  }

  protected shouldShowUserMessageToggle(message: OutputMessage): boolean {
    return shouldCollapseUserMessage(message);
  }

  protected isUserMessageExpanded(messageId: string): boolean {
    return this.expandedUserMessageIds().has(messageId);
  }

  protected toggleUserMessageExpansion(messageId: string): void {
    this.expandedUserMessageIds.update((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }

  onContextMenu(event: MouseEvent, item: DisplayItem): void {
    event.preventDefault();
    event.stopPropagation();
    const linkedFileTarget = this.getLinkedFileTargetFromEvent(event);
    if (linkedFileTarget) {
      this.showContextMenu(event, this.buildFileContextMenuItems(linkedFileTarget));
      return;
    }

    const menuItems = this.buildContextMenuItems(item);
    this.showContextMenu(event, menuItems);
  }

  private showContextMenu(event: MouseEvent, items: ContextMenuItem[]): void {
    if (items.length === 0) {
      this.closeContextMenu();
      return;
    }

    this.contextMenuX.set(event.clientX);
    this.contextMenuY.set(event.clientY);
    this.contextMenuItems.set(items);
    this.contextMenuVisible.set(true);
  }

  protected closeContextMenu(): void {
    this.contextMenuVisible.set(false);
    this.contextMenuItems.set([]);
  }

  private getLinkedFileTargetFromEvent(event: MouseEvent): LinkedFileTarget | null {
    const target = event.target as HTMLElement | null;
    const linkTarget = target?.closest('[data-file-path]') as HTMLElement | null;
    const rawPath = linkTarget?.getAttribute('data-file-path')?.trim();
    if (!rawPath) {
      return null;
    }
    return this.buildLinkedFileTarget(rawPath);
  }

  private buildFileContextMenuItems(target: LinkedFileTarget): ContextMenuItem[] {
    return [
      {
        id: 'copy-file-path',
        label: 'Copy path',
        action: () => void this.copyLinkedFilePath(target),
      },
      {
        id: 'copy-file',
        label: 'Copy file',
        disabled: !target.canUseLocalFileActions,
        action: () => void this.copyLinkedFile(target),
      },
      {
        id: 'open-file-manager',
        label: `Open in ${this.getSystemFileManagerLabel()}`,
        disabled: !target.canUseLocalFileActions,
        action: () => void this.openLinkedFileInFileManager(target),
      },
    ];
  }

  private buildContextMenuItems(item: DisplayItem): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    const content = item.message?.content || item.response?.content;
    const forkableMessage = item.message ?? item.response;
    const attachments = forkableMessage?.attachments;
    const hasCopyableImages =
      Array.isArray(attachments) &&
      attachments.some((a) => typeof a.data === 'string' && a.type.startsWith('image/'));
    if (content || hasCopyableImages) {
      items.push({
        label: 'Copy message',
        action: () => {
          void this.copyMessageContent(
            content ?? '',
            forkableMessage?.id ?? item.id,
            attachments,
          );
          this.closeContextMenu();
        },
      });
    }
    if (
      forkableMessage &&
      ['user', 'assistant'].includes(forkableMessage.type) &&
      item.bufferIndex !== undefined
    ) {
      items.push({
        label: 'Fork from here',
        divider: true,
        action: () => this.forkFromMessage(item),
      });
    }
    return items;
  }

  private async forkFromMessage(item: DisplayItem): Promise<void> {
    const instanceId = this.instanceId();
    const bufferIndex = item.bufferIndex;
    if (!instanceId || bufferIndex === undefined) return;
    this.closeContextMenu();

    const result = await this.ipc.forkSession(instanceId, bufferIndex + 1, `Fork at message ${bufferIndex + 1}`);

    if (result?.success && result.data) {
      const data = result.data as { id?: string };
      if (data.id) {
        this.instanceStore.setSelectedInstance(data.id);
      }
    }
  }

  private buildLinkedFileTarget(rawPath: string): LinkedFileTarget {
    const path = this.fileUrlToPath(rawPath.trim());
    const resolvedPath = this.resolvePathAgainstWorkingDirectory(path);
    return {
      rawPath: path,
      resolvedPath,
      displayPath: resolvedPath,
      canUseLocalFileActions: this.canUseLocalFileActions(path),
    };
  }

  private async copyLinkedFilePath(target: LinkedFileTarget): Promise<void> {
    const result = await this.clipboard.copyText(target.displayPath, { label: 'path' });
    if (!result.ok) {
      console.error('Failed to copy linked file path:', result.reason, result.cause);
    }
  }

  private async copyLinkedFile(target: LinkedFileTarget): Promise<void> {
    if (!target.canUseLocalFileActions) {
      return;
    }

    const response = await this.fileIpc.copyFileToClipboard(target.resolvedPath);
    if (!response.success) {
      console.error('Failed to copy linked file:', response.error?.message ?? 'Unknown error');
    }
  }

  private async openLinkedFileInFileManager(target: LinkedFileTarget): Promise<void> {
    if (!target.canUseLocalFileActions) {
      return;
    }

    const response = await this.fileIpc.revealFile(target.resolvedPath);
    if (!response.success) {
      console.error('Failed to reveal linked file:', response.error?.message ?? 'Unknown error');
    }
  }

  private canUseLocalFileActions(path: string): boolean {
    const instance = this.instanceStore.getInstance(this.instanceId());
    if (instance?.executionLocation?.type === 'remote') {
      return false;
    }

    return this.isAbsoluteFilePath(path) || Boolean(instance?.workingDirectory?.trim());
  }

  private resolvePathAgainstWorkingDirectory(path: string): string {
    if (!path || this.isAbsoluteFilePath(path)) {
      return path;
    }

    const workingDirectory = this.instanceStore.getInstance(this.instanceId())?.workingDirectory?.trim();
    if (!workingDirectory) {
      return path;
    }

    return this.joinAndNormalizePath(workingDirectory, path);
  }

  private fileUrlToPath(path: string): string {
    if (!path.startsWith('file://')) {
      return path;
    }

    try {
      const url = new URL(path);
      if (url.protocol !== 'file:') {
        return path;
      }
      return decodeURIComponent(url.pathname);
    } catch {
      return path;
    }
  }

  private isAbsoluteFilePath(path: string): boolean {
    return path.startsWith('/')
      || path.startsWith('\\\\')
      || path.startsWith('//')
      || /^[A-Za-z]:[\\/]/.test(path);
  }

  private joinAndNormalizePath(base: string, relative: string): string {
    const separator = this.pathSeparatorFor(base);
    const joined = `${base.replace(/[\\/]+$/, '')}${separator}${relative}`;
    return this.normalizePathLike(joined, separator);
  }

  private pathSeparatorFor(path: string): '/' | '\\' {
    return /^[A-Za-z]:[\\/]/.test(path) || (path.includes('\\') && !path.includes('/'))
      ? '\\'
      : '/';
  }

  private normalizePathLike(path: string, separator: '/' | '\\'): string {
    const driveMatch = /^([A-Za-z]:)[\\/](.*)$/.exec(path);
    let prefix = '';
    let rest = path;
    const absolute = this.isAbsoluteFilePath(path);

    if (driveMatch) {
      prefix = `${driveMatch[1]}${separator}`;
      rest = driveMatch[2];
    } else if (path.startsWith('\\\\') || path.startsWith('//')) {
      prefix = `${separator}${separator}`;
      rest = path.replace(/^[\\/]+/, '');
    } else if (path.startsWith('/')) {
      prefix = separator;
      rest = path.replace(/^[\\/]+/, '');
    }

    const segments: string[] = [];
    for (const segment of rest.split(/[\\/]+/)) {
      if (!segment || segment === '.') {
        continue;
      }
      if (segment === '..') {
        if (segments.length > 0 && segments[segments.length - 1] !== '..') {
          segments.pop();
        } else if (!absolute) {
          segments.push(segment);
        }
        continue;
      }
      segments.push(segment);
    }

    return `${prefix}${segments.join(separator)}`;
  }

  private getSystemFileManagerLabel(): string {
    if (navigator.userAgent.includes('Windows')) {
      return 'Explorer';
    }
    if (navigator.userAgent.includes('Linux')) {
      return 'Files';
    }
    return 'Finder';
  }

  private renderItemMarkdown(item: DisplayItem): void {
    item.renderedMessage = undefined;
    item.renderedResponse = undefined;

    if (item.type === 'message' && item.message) {
      const isToolMessage = item.message.type === 'tool_use' || item.message.type === 'tool_result';
      if (!isToolMessage && !this.isCompactionBoundary(item.message) && this.hasContent(item.message)) {
        item.renderedMessage = this.renderMarkdownContent(item.message.content, item.message.id);
      }
    }

    if (item.type === 'thought-group' && item.response && this.hasContent(item.response)) {
      item.renderedResponse = this.renderMarkdownContent(item.response.content, item.response.id);
    }
  }

  // LRU markdown cache - bounded at MAX_CACHE_SIZE entries, MAX_CACHEABLE_LENGTH content size
  // Keyed by messageId to avoid cache pollution from streaming intermediate strings
  private markdownCache = new Map<string, { content: string; rendered: RenderedMarkdown }>();
  private readonly MAX_CACHE_SIZE = 200;
  private readonly MAX_CACHEABLE_LENGTH = 50_000; // Skip caching very large content
  private renderMarkdownContent(content: string, messageId?: string): RenderedMarkdown {
    if (!content) return '';

    const cacheKey = messageId || content;

    // Check cache first — LRU: delete and re-insert to move to end
    const cached = this.markdownCache.get(cacheKey);
    if (cached !== undefined && cached.content === content) {
      this.markdownCache.delete(cacheKey);
      this.markdownCache.set(cacheKey, cached);
      return cached.rendered;
    }

    // Render with perf measurement
    const renderStart = performance.now();
    const rendered = this.markdownService.render(content);
    this.perf.recordMarkdownRender(content.length, performance.now() - renderStart);

    // Cache using messageId key — avoids pollution from intermediate streaming strings.
    // Skip caching very large content.
    if (content.length <= this.MAX_CACHEABLE_LENGTH) {
      // Evict oldest (first) entries if at capacity
      while (this.markdownCache.size >= this.MAX_CACHE_SIZE) {
        const firstKey = this.markdownCache.keys().next().value;
        if (firstKey) this.markdownCache.delete(firstKey);
        else break;
      }
      this.markdownCache.set(cacheKey, { content, rendered });
    }

    return rendered;
  }

  private getViewportElement(): HTMLDivElement | null {
    return this.container()?.nativeElement ?? null;
  }

  private getMessageSignature(messages: OutputMessage[]): string {
    return this.messageFormat.getMessageSignature(messages);
  }

}
