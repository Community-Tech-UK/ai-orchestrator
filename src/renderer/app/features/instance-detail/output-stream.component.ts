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
  ElementRef,
  viewChild,
  effect,
  inject,
  signal,
  ChangeDetectionStrategy,
  afterNextRender
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { OutputMessage } from '../../core/state/instance.store';
import { MarkdownService } from '../../core/services/markdown.service';
import { ElectronIpcService } from '../../core/services/ipc';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { MessageAttachmentsComponent } from '../../shared/components/message-attachments/message-attachments.component';
import { ThoughtProcessComponent } from '../../shared/components/thought-process/thought-process.component';
import { ToolGroupComponent } from '../../shared/components/tool-group/tool-group.component';
import { DisplayItemProcessor, DisplayItem } from './display-item-processor.service';

type RenderedMarkdown = ReturnType<MarkdownService['render']>;

/** Narrows DisplayItem's `unknown` rendered fields to RenderedMarkdown for template type safety */
interface RenderedDisplayItem extends DisplayItem {
  renderedMessage?: RenderedMarkdown;
  renderedResponse?: RenderedMarkdown;
}

@Component({
  selector: 'app-output-stream',
  standalone: true,
  imports: [DatePipe, MessageAttachmentsComponent, ThoughtProcessComponent, ToolGroupComponent],
  template: `
    <div class="output-stream" #container>
      @for (item of displayItems(); track item.id) {
        @if (item.type === 'thought-group') {
          <!-- Thought group with collapsible thinking section -->
          <!-- Only render thought-group if there's something to display -->
          @if (hasThoughtGroupContent(item)) {
            <div class="thought-group">
              @if ((item.thinking && item.thinking.length > 0) || (item.thoughts && item.thoughts.length > 0)) {
                @if (showThinking()) {
                  <app-thought-process
                    [thoughts]="item.thoughts || []"
                    [thinkingBlocks]="item.thinking"
                    [label]="getThoughtLabel(item.thoughts || [])"
                    [defaultExpanded]="thinkingDefaultExpanded()"
                  />
                }
              }
              @if (item.response && hasContent(item.response)) {
              <div class="message message-assistant" [class.continuation]="item.showHeader === false">
                @if (item.showHeader !== false) {
                <div class="message-header">
                  <span class="message-type">{{
                    getProviderDisplayName(provider())
                  }}</span>
                  <span class="message-time">
                    {{ item.response.timestamp | date: 'HH:mm:ss' }}
                  </span>
                  <button
                    class="copy-message-btn"
                    [class.copied]="isMessageCopied(item.response.id)"
                    (click)="
                      copyMessageContent(
                        item.response.content,
                        item.response.id
                      )
                    "
                    title="Copy to clipboard"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <rect
                        x="9"
                        y="9"
                        width="13"
                        height="13"
                        rx="2"
                        ry="2"
                      ></rect>
                      <path
                        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                      ></path>
                    </svg>
                    @if (isMessageCopied(item.response.id)) {
                      <span class="copy-label">Copied</span>
                    }
                  </button>
                </div>
                }
                <div class="message-content">
                  <div
                    class="markdown-content"
                    [innerHTML]="item.renderedResponse"
                  ></div>
                  @if (
                    item.response.attachments &&
                    item.response.attachments.length > 0
                  ) {
                    <app-message-attachments
                      [attachments]="item.response.attachments"
                    />
                  }
                </div>
              </div>
            }
            </div>
          }
        } @else if (item.type === 'tool-group' && item.toolMessages) {
          <!-- Grouped tool calls in collapsible accordion -->
          <app-tool-group [toolMessages]="item.toolMessages" />
        } @else if (item.message) {
          <!-- Regular message -->
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
                <span class="message-type">{{
                  formatType(item.message.type)
                }}</span>
                @if (item.repeatCount && item.repeatCount > 1) {
                  <span class="repeat-badge">&times;{{ item.repeatCount }}</span>
                }
                <span class="message-time">
                  {{ item.message.timestamp | date: 'HH:mm:ss' }}
                </span>
                @if (
                  item.message.type === 'user' ||
                  item.message.type === 'assistant'
                ) {
                  <button
                    class="copy-message-btn"
                    [class.copied]="isMessageCopied(item.message.id)"
                    (click)="
                      copyMessageContent(item.message.content, item.message.id)
                    "
                    title="Copy to clipboard"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <rect
                        x="9"
                        y="9"
                        width="13"
                        height="13"
                        rx="2"
                        ry="2"
                      ></rect>
                      <path
                        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                      ></path>
                    </svg>
                    @if (isMessageCopied(item.message.id)) {
                      <span class="copy-label">Copied</span>
                    }
                  </button>
                }
              </div>
              }
              <div class="message-content">
                @if (
                  item.message.type === 'tool_use' ||
                  item.message.type === 'tool_result'
                ) {
                  <div class="code-block-wrapper">
                    <div class="code-block-header">
                      <span class="code-language">{{
                        getToolName(item.message)
                      }}</span>
                    </div>
                    <pre
                      class="hljs"
                    ><code>{{ formatContent(item.message) }}</code></pre>
                  </div>
                } @else {
                  <div
                    class="markdown-content"
                    [innerHTML]="item.renderedMessage"
                  ></div>
                }
                @if (
                  item.message.attachments &&
                  item.message.attachments.length > 0
                ) {
                  <app-message-attachments
                    [attachments]="item.message.attachments"
                  />
                }
              </div>
            </div>
          }
        }
      } @empty {
        <div class="empty-stream">
          <p>No messages yet</p>
          <p class="hint">Start a conversation</p>
        </div>
      }

      <!-- Scroll to bottom button -->
      @if (showScrollToBottom()) {
        <button
          class="scroll-to-bottom-btn"
          (click)="scrollToBottom()"
          title="Scroll to bottom"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
      }

      .output-stream {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 4px;
        background: transparent;
        border-radius: 22px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        position: relative;
      }

      .message {
        width: min(100%, 920px);
        padding: 12px 14px;
        border-radius: 18px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0)),
          rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.05);
        content-visibility: auto;
        contain-intrinsic-size: auto 80px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
      }

      /* Continuation messages from the same sender — tighter spacing, no top radius */
      .message.continuation {
        margin-top: -6px;
        border-top-left-radius: 12px;
        border-top-right-radius: 12px;
        padding-top: 9px;
      }

      .message-user {
        margin-left: auto;
        background:
          linear-gradient(180deg, rgba(var(--primary-rgb), 0.18), rgba(var(--primary-rgb), 0.12)),
          rgba(255, 255, 255, 0.03);
        border-color: rgba(var(--primary-rgb), 0.24);
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
      }

      .message-system {
        background: rgba(var(--info-rgb), 0.08);
        font-size: 13px;
        color: var(--info-color);
      }

      .message-error {
        background: var(--error-bg);
        color: var(--error-color);
      }

      .message-tool_use,
      .message-tool_result {
        background: rgba(6, 10, 9, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.05);
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
        margin-bottom: 8px;
        font-size: 10px;
      }

      .message-type {
        text-transform: uppercase;
        font-weight: 600;
        letter-spacing: 0.12em;
        opacity: 0.58;
        font-family: var(--font-mono);
      }

      .message-time {
        font-family: var(--font-mono);
        opacity: 0.45;
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
        font-size: var(--output-font-size, 14px);
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
        gap: var(--spacing-sm);
        width: min(100%, 920px);
        margin-right: auto;
        content-visibility: auto;
        contain-intrinsic-size: auto 120px;
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
        position: sticky;
        bottom: 20px;
        align-self: flex-end;
        margin-top: -40px;
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

  container = viewChild<ElementRef>('container');

  // Scroll state - stored per instance
  protected showScrollToBottom = signal(false);
  private userScrolledUp = false;
  private scrollPositions = new Map<string, number>(); // instanceId -> scrollTop
  private previousInstanceId: string | null = null;

  protected copiedMessageId = signal<string | null>(null);
  private copyResetTimer: number | null = null;

  private markdownService = inject(MarkdownService);
  private ipc = inject(ElectronIpcService);
  private perf = inject(PerfInstrumentationService);
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

  constructor() {
    // Handle instance changes - save/restore scroll position
    effect(() => {
      const currentInstanceId = this.instanceId();
      const el = this.container()?.nativeElement;

      if (this.previousInstanceId && this.previousInstanceId !== currentInstanceId && el) {
        // Save scroll position for the previous instance
        this.scrollPositions.set(this.previousInstanceId, el.scrollTop);
      }

      if (currentInstanceId !== this.previousInstanceId) {
        // Instance changed - reset scroll state
        this.userScrolledUp = false;
        this.showScrollToBottom.set(false);

        // Perf: measure thread switch time and transcript paint
        const stopSwitch = this.perf.markThreadSwitch(this.previousInstanceId, currentInstanceId);
        const stopPaint = this.perf.markTranscriptPaint(currentInstanceId, this.messages().length);

        // Restore scroll position for the new instance using rAF for frame alignment
        requestAnimationFrame(() => {
          const savedPosition = this.scrollPositions.get(currentInstanceId);
          const containerEl = this.container()?.nativeElement;
          if (containerEl) {
            if (savedPosition !== undefined) {
              containerEl.scrollTop = savedPosition;
              const scrollPosition = containerEl.scrollTop + containerEl.clientHeight;
              const scrollHeight = containerEl.scrollHeight;
              this.userScrolledUp = scrollPosition < scrollHeight - 100;
              this.showScrollToBottom.set(scrollPosition < scrollHeight - 50);
            } else {
              containerEl.scrollTop = containerEl.scrollHeight;
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
      const el = this.container()?.nativeElement;
      if (el && msgs.length > 0) {
        requestAnimationFrame(() => {
          if (!this.userScrolledUp) {
            el.scrollTop = el.scrollHeight;
          }
        });
      }
    });

    // Setup scroll listener and delegated click handler after render
    afterNextRender(() => {
      this.setupDelegatedClickHandler();
      this.setupScrollListener();
    });
  }

  /**
   * Setup scroll event listener to detect user scrolling
   */
  private setupScrollListener(): void {
    const el = this.container()?.nativeElement;
    if (!el) return;

    let lastScrollTime = 0;

    el.addEventListener('scroll', () => {
      // Measure scroll frame timing for perf budget
      const now = performance.now();
      if (lastScrollTime > 0) {
        this.perf.recordScrollFrame(this.instanceId(), now - lastScrollTime, this.messages().length);
      }
      lastScrollTime = now;

      const scrollPosition = el.scrollTop + el.clientHeight;
      const scrollHeight = el.scrollHeight;
      const autoScrollThreshold = 100;
      const buttonShowThreshold = 50;

      const isAtBottom = scrollPosition >= scrollHeight - autoScrollThreshold;
      const shouldShowButton = scrollPosition < scrollHeight - buttonShowThreshold;

      this.userScrolledUp = !isAtBottom;
      this.showScrollToBottom.set(shouldShowButton);
    }, { passive: true });
  }

  /**
   * Scroll to the bottom of the container
   */
  scrollToBottom(): void {
    const el = this.container()?.nativeElement;
    if (el) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'smooth'
      });
      this.userScrolledUp = false;
      this.showScrollToBottom.set(false);
    }
  }

  /**
   * Setup a single delegated click handler on the container for copy buttons and file paths.
   * This replaces per-element querySelectorAll scanning that ran every 100ms.
   */
  private setupDelegatedClickHandler(): void {
    const el = this.container()?.nativeElement;
    if (!el) return;

    el.addEventListener('click', (event: MouseEvent) => {
      const target = event.target as HTMLElement;

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
        event.preventDefault();
        event.stopPropagation();
        const filePath = filePathEl.getAttribute('data-file-path');
        if (filePath) {
          this.onFilePathClick(filePath);
        }
      }
    });
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
