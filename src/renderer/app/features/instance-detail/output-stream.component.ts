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
  viewChild,
  effect,
  inject,
  signal,
  ChangeDetectionStrategy,
  afterNextRender,
  DestroyRef
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { ScrollingModule, CdkVirtualScrollViewport, VIRTUAL_SCROLL_STRATEGY } from '@angular/cdk/scrolling';
import { OutputMessage } from '../../core/state/instance.store';
import { MarkdownService } from '../../core/services/markdown.service';
import { ElectronIpcService } from '../../core/services/ipc';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { MessageAttachmentsComponent } from '../../shared/components/message-attachments/message-attachments.component';
import { ThoughtProcessComponent } from '../../shared/components/thought-process/thought-process.component';
import { ToolGroupComponent } from '../../shared/components/tool-group/tool-group.component';
import { DisplayItemProcessor, DisplayItem } from './display-item-processor.service';
import { TranscriptScrollStrategy } from './transcript-scroll-strategy';

type RenderedMarkdown = ReturnType<MarkdownService['render']>;

/** Narrows DisplayItem's `unknown` rendered fields to RenderedMarkdown for template type safety */
interface RenderedDisplayItem extends DisplayItem {
  renderedMessage?: RenderedMarkdown;
  renderedResponse?: RenderedMarkdown;
}

@Component({
  selector: 'app-output-stream',
  standalone: true,
  imports: [DatePipe, MessageAttachmentsComponent, ThoughtProcessComponent, ToolGroupComponent, ScrollingModule],
  providers: [
    TranscriptScrollStrategy,
    { provide: VIRTUAL_SCROLL_STRATEGY, useExisting: TranscriptScrollStrategy },
  ],
  template: `
    @if (displayItems().length === 0) {
      <div class="empty-stream">
        <p>No messages yet</p>
        <p class="hint">Start a conversation</p>
      </div>
    } @else {
      <cdk-virtual-scroll-viewport class="output-stream" #container>
        <div *cdkVirtualFor="let item of displayItems(); let i = index; trackBy: trackByItemId"
             class="transcript-item"
             [attr.data-item-index]="i">
          @if (item.type === 'thought-group') {
            @if (hasThoughtGroupContent(item)) {
              <div class="thought-group">
                @if ((item.thinking && item.thinking.length > 0) || (item.thoughts && item.thoughts.length > 0)) {
                  @if (showThinking()) {
                    <app-thought-process
                      [thoughts]="item.thoughts || []"
                      [thinkingBlocks]="item.thinking"
                      [label]="getThoughtLabel(item.thoughts || [])"
                      [defaultExpanded]="thinkingDefaultExpanded()"
                      [instanceId]="instanceId()"
                      [itemId]="item.id"
                    />
                  }
                }
                @if (item.response && hasContent(item.response)) {
                  <div class="message message-assistant" [class.continuation]="item.showHeader === false">
                    @if (item.showHeader !== false) {
                      <div class="message-header">
                        <span class="message-type">{{ getProviderDisplayName(provider()) }}</span>
                        <span class="message-time">{{ item.response.timestamp | date: 'HH:mm:ss' }}</span>
                        <button class="copy-message-btn" [class.copied]="isMessageCopied(item.response.id)"
                          (click)="copyMessageContent(item.response.content, item.response.id)"
                          title="Copy to clipboard">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                          </svg>
                          @if (isMessageCopied(item.response.id)) {
                            <span class="copy-label">Copied</span>
                          }
                        </button>
                      </div>
                    }
                    <div class="message-content">
                      <div class="markdown-content" [innerHTML]="item.renderedResponse"></div>
                      @if (item.response.attachments && item.response.attachments.length > 0) {
                        <app-message-attachments [attachments]="item.response.attachments" />
                      }
                    </div>
                  </div>
                }
              </div>
            }
          } @else if (item.type === 'tool-group' && item.toolMessages) {
            <app-tool-group [toolMessages]="item.toolMessages" [instanceId]="instanceId()" [itemId]="item.id" />
          } @else if (item.message) {
            @if (isCompactionBoundary(item.message)) {
              <div class="compaction-boundary">
                <div class="boundary-line"></div>
                <span class="boundary-label">{{ getCompactionLabel(item.message) }}</span>
                <div class="boundary-line"></div>
              </div>
            } @else if (hasContent(item.message)) {
              <div class="message" [class]="'message-' + item.message.type" [class.continuation]="item.showHeader === false">
                @if (item.showHeader !== false) {
                  <div class="message-header">
                    <span class="message-type">{{ formatType(item.message.type) }}</span>
                    @if (item.repeatCount && item.repeatCount > 1) {
                      <span class="repeat-badge">&times;{{ item.repeatCount }}</span>
                    }
                    <span class="message-time">{{ item.message.timestamp | date: 'HH:mm:ss' }}</span>
                    @if (item.message.type === 'user' || item.message.type === 'assistant') {
                      <button class="copy-message-btn" [class.copied]="isMessageCopied(item.message.id)"
                        (click)="copyMessageContent(item.message.content, item.message.id)"
                        title="Copy to clipboard">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                        @if (isMessageCopied(item.message.id)) {
                          <span class="copy-label">Copied</span>
                        }
                      </button>
                    }
                  </div>
                }
                <div class="message-content">
                  @if (item.message.type === 'tool_use' || item.message.type === 'tool_result') {
                    <div class="code-block-wrapper">
                      <div class="code-block-header">
                        <span class="code-language">{{ getToolName(item.message) }}</span>
                      </div>
                      <pre class="hljs"><code>{{ formatContent(item.message) }}</code></pre>
                    </div>
                  } @else {
                    <div class="markdown-content" [innerHTML]="item.renderedMessage"></div>
                  }
                  @if (item.message.attachments && item.message.attachments.length > 0) {
                    <app-message-attachments [attachments]="item.message.attachments" />
                  }
                </div>
              </div>
            }
          }
        </div>
      </cdk-virtual-scroll-viewport>
    }

    <!-- Scroll to bottom button -->
    @if (showScrollToBottom()) {
      <button class="scroll-to-bottom-btn" (click)="scrollToBottom()" title="Scroll to bottom">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        position: relative;
      }

      cdk-virtual-scroll-viewport.output-stream {
        flex: 1;
        min-height: 0;
        height: 100%;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 8px 12px 8px 4px;
        background: transparent;
        border-radius: 18px;
        position: relative;
      }

      :host ::ng-deep .cdk-virtual-scroll-content-wrapper {
        width: 100%;
        max-width: 100%;
        min-width: 0;
        box-sizing: border-box;
      }

      .transcript-item {
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
      }

      .message {
        width: 100%;
        max-width: none;
        min-width: 0;
        box-sizing: border-box;
        padding: 8px 0;
        border-radius: 0;
        background: transparent;
        border: none;
        box-shadow: none;
        margin-bottom: 10px;
      }

      /* Continuation messages from the same sender — tighter spacing, no top radius */
      .message.continuation {
        margin-top: -8px;
        padding-top: 0;
      }

      .message-user {
        width: 100%;
        margin-left: auto;
        padding: 12px 14px;
        border-radius: 20px;
        background:
          linear-gradient(180deg, rgba(var(--primary-rgb), 0.18), rgba(var(--primary-rgb), 0.12)),
          rgba(255, 255, 255, 0.03);
        border-color: rgba(var(--primary-rgb), 0.24);
        border: 1px solid rgba(var(--primary-rgb), 0.24);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
        color: var(--text-primary);

        .message-type,
        .message-time {
          color: rgba(243, 239, 229, 0.6);
        }

        .markdown-content {
          color: var(--text-primary);

          /* Ensure all text elements inherit the calmer user tint */
          h1,
          h2,
          h3,
          h4,
          h5,
          h6,
          p,
          li,
          strong,
          em,
          b,
          i {
            color: inherit;
          }

          ul,
          ol {
            color: inherit;
          }

          li::marker {
            color: rgba(243, 239, 229, 0.72);
          }

          a {
            color: var(--text-primary);
            text-decoration: underline;
            font-weight: 600;

            &:hover {
              background: rgba(255, 255, 255, 0.08);
              border-radius: 2px;
            }
          }

          .inline-code {
            background: rgba(255, 255, 255, 0.08);
            color: inherit;
            border-color: rgba(255, 255, 255, 0.1);
          }
        }

        .copy-message-btn {
          color: rgba(243, 239, 229, 0.52);

          &:hover {
            color: var(--text-primary);
            background: rgba(255, 255, 255, 0.08);
          }
        }
      }

      /* Text selection for user messages - needs ::ng-deep to pierce shadow DOM */
      :host ::ng-deep .message-user {
        *::selection {
          background: rgba(0, 0, 0, 0.35) !important;
          color: #fff !important;
        }

        *::-moz-selection {
          background: rgba(0, 0, 0, 0.35) !important;
          color: #fff !important;
        }
      }

      /* File attachment chip styling inside user messages */
      :host ::ng-deep .message-user app-message-attachments .file-attachment {
        background: rgba(0, 0, 0, 0.15);
        border-color: rgba(0, 0, 0, 0.2);
      }

      :host ::ng-deep .message-user app-message-attachments .file-name,
      :host ::ng-deep .message-user app-message-attachments .file-size {
        color: #1a1a1a;
      }

      :host ::ng-deep .message-user app-message-attachments .file-attachment:hover {
        background: rgba(0, 0, 0, 0.25);
        border-color: rgba(0, 0, 0, 0.3);
      }

      .message-assistant {
        margin-right: auto;
        color: var(--text-primary);
      }

      .message-system {
        width: 100%;
        padding: 10px 12px;
        background: rgba(var(--info-rgb), 0.08);
        border: 1px solid rgba(var(--info-rgb), 0.14);
        border-radius: 14px;
        font-size: 13px;
        color: var(--info-color);
      }

      .message-error {
        width: 100%;
        padding: 10px 12px;
        background: var(--error-bg);
        border: 1px solid rgba(var(--error-rgb), 0.16);
        border-radius: 14px;
        color: var(--error-color);
      }

      .message-tool_use,
      .message-tool_result {
        width: 100%;
        padding: 10px 12px;
        background: rgba(6, 10, 9, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 16px;
        font-size: 12px;
      }

      .repeat-badge {
        font-size: 11px;
        font-weight: 600;
        color: var(--error-color, #ef4444);
        background: var(--error-bg, rgba(239, 68, 68, 0.1));
        padding: 1px 6px;
        border-radius: 10px;
        line-height: 1.2;
      }

      .message-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        min-width: 0;
        margin-bottom: 6px;
        font-size: 9px;
      }

      .message-type {
        text-transform: uppercase;
        font-weight: 600;
        letter-spacing: 0.14em;
        opacity: 0.46;
        font-family: var(--font-mono);
      }

      .message-time {
        font-family: var(--font-mono);
        opacity: 0.32;
        margin-left: auto;
      }

      .copy-message-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 28px;
        height: 28px;
        padding: 0 6px;
        background: transparent;
        border: none;
        border-radius: var(--radius-sm);
        color: var(--text-muted);
        cursor: pointer;
        opacity: 0;
        transition: all var(--transition-fast);

        &:hover {
          background: var(--bg-hover);
          color: var(--text-primary);
        }

        svg {
          flex-shrink: 0;
        }
      }

      .copy-message-btn.copied {
        background: rgba(34, 197, 94, 0.12);
        color: #16a34a;
        border: 1px solid rgba(34, 197, 94, 0.4);
        opacity: 1;
      }

      .copy-label {
        font-size: 11px;
        font-weight: 600;
        margin-left: 4px;
      }

      .message:hover .copy-message-btn {
        opacity: 1;
      }

      .message-content {
        line-height: 1.62;
        font-size: var(--output-font-size, 15px);
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .empty-stream {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--text-secondary);
        text-align: center;
        border: 1px dashed rgba(255, 255, 255, 0.08);
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.02);
      }

      .empty-stream .hint {
        font-size: 12px;
        color: var(--text-muted);
        margin-top: var(--spacing-xs);
      }

      .thought-group {
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: 100%;
        max-width: none;
        min-width: 0;
        box-sizing: border-box;
        margin-right: auto;
        margin-bottom: 12px;
      }

      .thought-group .message-assistant {
        margin-right: 0;
      }

      /* File path styling - make clickable */
      :host ::ng-deep .file-path {
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          background: rgba(var(--primary-rgb), 0.2);
          border-color: var(--primary-color);
          text-decoration: underline;
        }
      }

      .scroll-to-bottom-btn {
        position: absolute;
        bottom: 20px;
        right: 20px;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: rgba(12, 18, 17, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: var(--text-secondary);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        transition: all var(--transition-fast);
        z-index: 10;
        flex-shrink: 0;

        &:hover {
          background: rgba(var(--primary-rgb), 0.92);
          border-color: rgba(var(--primary-rgb), 0.92);
          color: var(--bg-primary);
          transform: scale(1.05);
          box-shadow: 0 10px 20px rgba(var(--primary-rgb), 0.24);
        }

        svg {
          flex-shrink: 0;
        }
      }

      .compaction-boundary {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        padding: 6px 0;
        user-select: none;
      }

      .boundary-line {
        flex: 1;
        height: 1px;
        background: linear-gradient(
          to right,
          transparent,
          var(--border-color),
          transparent
        );
      }

      .boundary-label {
        font-size: 11px;
        font-family: var(--font-mono);
        color: var(--text-muted);
        white-space: nowrap;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OutputStreamComponent {
  messages = input.required<OutputMessage[]>();
  instanceId = input.required<string>();
  provider = input<string>('claude');
  showThinking = input<boolean>(true);
  thinkingDefaultExpanded = input<boolean>(false);

  container = viewChild<CdkVirtualScrollViewport>('container');

  // Scroll state - stored per instance
  protected showScrollToBottom = signal(false);
  private userScrolledUp = false;
  private scrollPositions = new Map<string, number>(); // instanceId -> scrollOffset
  private previousInstanceId: string | null = null;

  protected copiedMessageId = signal<string | null>(null);
  private copyResetTimer: number | null = null;

  private markdownService = inject(MarkdownService);
  private ipc = inject(ElectronIpcService);
  private perf = inject(PerfInstrumentationService);
  private scrollStrategy = inject(TranscriptScrollStrategy);
  private destroyRef = inject(DestroyRef);
  private displayItemProcessor = new DisplayItemProcessor();

  private resizeObserver: ResizeObserver | null = null;
  private observeItemsFrame: number | null = null;

  /**
   * Shows all messages, consolidating streaming messages with the same ID.
   * Streaming messages (from Copilot SDK) have metadata.streaming=true and share the same ID.
   * We display only the accumulated content for streaming messages.
   */
  displayItems = computed<RenderedDisplayItem[]>(() => {
    const startTime = performance.now();
    const messages = this.messages();
    const instanceId = this.instanceId();

    const items = this.displayItemProcessor.process(messages, instanceId);

    // Incremental markdown rendering: only render new items
    const newCount = this.displayItemProcessor.newItemCount;
    if (newCount > 0) {
      const startIdx = items.length - newCount;
      for (let i = startIdx; i < items.length; i++) {
        this.renderItemMarkdown(items[i]);
      }
    }

    const duration = performance.now() - startTime;
    this.perf.recordDisplayItemsCompute(messages.length, items.length, duration);

    // Safe cast: renderItemMarkdown() populates renderedMessage/renderedResponse with RenderedMarkdown
    return items as RenderedDisplayItem[];
  });

  trackByItemId(_index: number, item: RenderedDisplayItem): string {
    return item.id;
  }

  constructor() {
    // Notify scroll strategy about data length changes and set type hints for new items
    effect(() => {
      const items = this.displayItems();
      this.scrollStrategy.setDataLength(items.length);

      const newCount = this.displayItemProcessor.newItemCount;
      if (newCount > 0) {
        const startIdx = items.length - newCount;
        for (let i = startIdx; i < items.length; i++) {
          this.scrollStrategy.setItemTypeHint(i, items[i].type);
        }
      }
    });

    effect(() => {
      this.displayItems();
      if (this.container()) {
        this.scheduleRenderedItemObservation();
      }
    });

    // Handle instance changes - save/restore scroll position
    effect(() => {
      const currentInstanceId = this.instanceId();
      const vp = this.container();

      if (this.previousInstanceId && this.previousInstanceId !== currentInstanceId && vp) {
        // Save scroll position for the previous instance
        this.scrollPositions.set(this.previousInstanceId, vp.measureScrollOffset());
      }

      if (currentInstanceId !== this.previousInstanceId) {
        // Instance changed - reset scroll state and strategy cache
        this.userScrolledUp = false;
        this.showScrollToBottom.set(false);
        this.scrollStrategy.clearCache();

        // Perf: measure thread switch time and transcript paint
        const stopSwitch = this.perf.markThreadSwitch(this.previousInstanceId, currentInstanceId);
        const stopPaint = this.perf.markTranscriptPaint(currentInstanceId, this.messages().length);

        // Restore scroll position for the new instance using rAF for frame alignment
        requestAnimationFrame(() => {
          const savedPosition = this.scrollPositions.get(currentInstanceId);
          const viewport = this.container();
          if (viewport) {
            if (savedPosition !== undefined) {
              viewport.scrollToOffset(savedPosition);
              const scrollOffset = viewport.measureScrollOffset();
              const viewportSize = viewport.getViewportSize();
              const totalSize = viewport.measureRenderedContentSize();
              const distanceFromBottom = totalSize - scrollOffset - viewportSize;
              this.userScrolledUp = distanceFromBottom > 100;
              this.showScrollToBottom.set(distanceFromBottom > 50);
            } else {
              viewport.scrollToOffset(viewport.measureRenderedContentSize());
            }
          }
          stopPaint();
          stopSwitch();
        });

        this.previousInstanceId = currentInstanceId;
      }
    });

    // Auto-scroll to bottom when new messages arrive (only if user hasn't scrolled up)
    effect(() => {
      const msgs = this.messages();
      const vp = this.container();
      if (vp && msgs.length > 0) {
        requestAnimationFrame(() => {
          if (!this.userScrolledUp) {
            vp.scrollToOffset(vp.measureRenderedContentSize() + 999999);
          }
        });
      }
    });

    // Setup scroll listener, delegated click handler, and ResizeObserver after render
    afterNextRender(() => {
      const clickBinding = this.setupDelegatedClickHandler();
      const scrollBinding = this.setupScrollListener();

      this.resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const indexStr = el.getAttribute('data-item-index');
          if (indexStr) {
            const index = parseInt(indexStr, 10);
            if (index >= 0) {
              this.scrollStrategy.setItemHeight(index, this.measureTranscriptItemHeight(el));
            }
          }
        }
      });

      this.observeRenderedItems();

      this.destroyRef.onDestroy(() => {
        this.resizeObserver?.disconnect();
        if (this.observeItemsFrame !== null) {
          cancelAnimationFrame(this.observeItemsFrame);
          this.observeItemsFrame = null;
        }

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

  private scheduleRenderedItemObservation(): void {
    if (this.observeItemsFrame !== null) {
      cancelAnimationFrame(this.observeItemsFrame);
    }

    this.observeItemsFrame = requestAnimationFrame(() => {
      this.observeItemsFrame = null;
      this.observeRenderedItems();
    });
  }

  private observeRenderedItems(): void {
    const vp = this.container();
    if (!vp || !this.resizeObserver) return;

    const viewportEl = vp.elementRef.nativeElement as HTMLElement;
    const transcriptItems = Array.from(viewportEl.querySelectorAll<HTMLElement>('.transcript-item'));

    this.resizeObserver.disconnect();

    for (const item of transcriptItems) {
      const indexStr = item.getAttribute('data-item-index');
      if (indexStr) {
        const index = parseInt(indexStr, 10);
        if (index >= 0) {
          this.scrollStrategy.setItemHeight(index, this.measureTranscriptItemHeight(item));
        }
      }
      this.resizeObserver.observe(item);
    }
  }

  private measureTranscriptItemHeight(item: HTMLElement): number {
    const firstChild = item.firstElementChild as HTMLElement | null;
    if (!firstChild) {
      return Math.ceil(item.getBoundingClientRect().height);
    }

    const rect = firstChild.getBoundingClientRect();
    const styles = getComputedStyle(firstChild);
    const marginTop = parseFloat(styles.marginTop) || 0;
    const marginBottom = parseFloat(styles.marginBottom) || 0;
    return Math.ceil(rect.height + marginTop + marginBottom);
  }

  /**
   * Setup scroll event listener to detect user scrolling.
   * Returns the element and bound listener so the caller can remove it on destroy.
   */
  private setupScrollListener(): { element: HTMLElement; listener: EventListener } | null {
    const vp = this.container();
    if (!vp) return null;

    const el = vp.elementRef.nativeElement as HTMLElement;
    let lastScrollTime = 0;

    const listener: EventListener = () => {
      // Measure scroll frame timing for perf budget
      const now = performance.now();
      if (lastScrollTime > 0) {
        this.perf.recordScrollFrame(this.instanceId(), now - lastScrollTime, this.messages().length);
      }
      lastScrollTime = now;

      const scrollOffset = vp.measureScrollOffset();
      const viewportSize = vp.getViewportSize();
      const totalSize = vp.measureRenderedContentSize();
      const autoScrollThreshold = 100;
      const buttonShowThreshold = 50;

      const distanceFromBottom = totalSize - scrollOffset - viewportSize;

      this.userScrolledUp = distanceFromBottom > autoScrollThreshold;
      this.showScrollToBottom.set(distanceFromBottom > buttonShowThreshold);
    };

    el.addEventListener('scroll', listener, { passive: true });
    return { element: el, listener };
  }

  /**
   * Scroll to the bottom of the container
   */
  scrollToBottom(): void {
    const vp = this.container();
    if (vp) {
      vp.scrollToOffset(vp.measureScrollOffset() + 999999, 'smooth');
      this.userScrolledUp = false;
      this.showScrollToBottom.set(false);
    }
  }

  /**
   * Setup a single delegated click handler on the container for copy buttons and file paths.
   * This replaces per-element querySelectorAll scanning that ran every 100ms.
   * Returns the element and bound listener so the caller can remove it on destroy.
   */
  private setupDelegatedClickHandler(): { element: HTMLElement; listener: EventListener } | null {
    const vp = this.container();
    if (!vp) return null;

    const el = vp.elementRef.nativeElement as HTMLElement;

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

      // Check for file path clicks
      const filePathEl = target.closest('[data-file-path]') as HTMLElement | null;
      if (filePathEl) {
        mouseEvent.preventDefault();
        mouseEvent.stopPropagation();
        const filePath = filePathEl.getAttribute('data-file-path');
        if (filePath) {
          this.onFilePathClick(filePath);
        }
      }
    };

    el.addEventListener('click', listener);
    return { element: el, listener };
  }

  /**
   * Handle click on a file path - open the file in the system's default editor
   */
  private onFilePathClick(filePath: string): void {
    console.log('Opening file:', filePath);
    this.ipc.openPath(filePath);
  }

  /**
   * Copy message content to clipboard
   */
  copyMessageContent(content: string, messageId: string): void {
    if (!content) return;

    navigator.clipboard
      .writeText(content)
      .then(() => {
        this.copiedMessageId.set(messageId);
        if (this.copyResetTimer) {
          window.clearTimeout(this.copyResetTimer);
        }
        this.copyResetTimer = window.setTimeout(() => {
          this.copiedMessageId.set(null);
        }, 2000);
      })
      .catch((err) => {
        console.error('Failed to copy message:', err);
      });
  }

  isMessageCopied(messageId: string): boolean {
    return this.copiedMessageId() === messageId;
  }

  formatType(type: string): string {
    if (type === 'assistant') {
      return this.getProviderDisplayName(this.provider());
    }
    const labels: Record<string, string> = {
      user: 'You',
      system: 'System',
      tool_use: 'Tool',
      tool_result: 'Result',
      error: 'Error'
    };
    return labels[type] || type;
  }

  protected getProviderDisplayName(provider: string): string {
    switch (provider) {
      case 'claude':
        return 'Claude';
      case 'copilot':
        return 'Copilot';
      case 'codex':
        return 'Codex';
      case 'gemini':
        return 'Gemini';
      case 'ollama':
        return 'Ollama';
      default:
        return 'AI';
    }
  }

  hasContent(message: OutputMessage): boolean {
    // Check if message has meaningful content to display
    if (message.type === 'tool_use' || message.type === 'tool_result') {
      return !!message.metadata || !!message.content;
    }
    // User messages may have attachments without text
    if (message.attachments && message.attachments.length > 0) {
      return true;
    }
    return !!message.content?.trim();
  }

  isCompactionBoundary(message: OutputMessage): boolean {
    return message.type === 'system' && !!message.metadata?.['isCompactionBoundary'];
  }

  getCompactionLabel(message: OutputMessage): string {
    const meta = message.metadata;
    if (!meta) return 'Context compacted';

    const prev = meta['previousUsage'] as { percentage?: number } | undefined;
    const next = meta['newUsage'] as { percentage?: number } | undefined;
    const method = meta['method'] as 'native' | 'restart-with-summary' | undefined;
    const methodLabel = method ? `[${method}]` : '';

    if (prev?.percentage !== undefined && next?.percentage !== undefined) {
      return `Context compacted ${methodLabel} (${Math.round(prev.percentage)}% → ${Math.round(next.percentage)}%)`.trim();
    }

    return `Context compacted ${methodLabel}`.trim();
  }

  /**
   * Check if a thought-group has any content to display
   * Returns false if thinking is hidden AND response is empty
   */
  hasThoughtGroupContent(item: DisplayItem): boolean {
    const hasThinking = (item.thinking && item.thinking.length > 0) ||
                       (item.thoughts && item.thoughts.length > 0);
    const showsThinking = hasThinking && this.showThinking();
    const hasResponse = !!(item.response && this.hasContent(item.response));

    return showsThinking || hasResponse;
  }

  getToolName(message: OutputMessage): string {
    if (message.metadata && 'name' in message.metadata) {
      return String(message.metadata['name']);
    }
    return message.type === 'tool_use' ? 'Tool Call' : 'Result';
  }

  formatContent(message: OutputMessage): string {
    if (message.metadata) {
      return JSON.stringify(message.metadata, null, 2);
    }
    return message.content || '';
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

  /**
   * Generate a label for the thought process section
   */
  getThoughtLabel(thoughts: string[]): string {
    if (thoughts.length === 0) return 'Thought process';

    // Try to create a short summary from the first thought
    const firstThought = thoughts[0];
    const firstSentence = firstThought.split(/[.!?\n]/)[0].trim();

    if (firstSentence.length > 60) {
      return firstSentence.slice(0, 57) + '...';
    }

    return firstSentence || 'Thought process';
  }

}
