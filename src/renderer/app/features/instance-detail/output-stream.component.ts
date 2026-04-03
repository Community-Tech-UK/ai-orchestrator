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
  DestroyRef,
  ElementRef,
  untracked
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { OutputMessage } from '../../core/state/instance.store';
import { MarkdownService } from '../../core/services/markdown.service';
import { ElectronIpcService, InstanceIpcService } from '../../core/services/ipc';
import { InstanceOutputStore } from '../../core/state/instance/instance-output.store';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { MessageAttachmentsComponent } from '../../shared/components/message-attachments/message-attachments.component';
import { ThoughtProcessComponent } from '../../shared/components/thought-process/thought-process.component';
import { ToolGroupComponent } from '../../shared/components/tool-group/tool-group.component';
import { DisplayItemProcessor, DisplayItem } from './display-item-processor.service';
import { ContextMenuComponent, ContextMenuItem } from '../../shared/components/context-menu/context-menu.component';
import { InstanceStore } from '../../core/state/instance/instance.store';

type RenderedMarkdown = ReturnType<MarkdownService['render']>;

/** Narrows DisplayItem's `unknown` rendered fields to RenderedMarkdown for template type safety */
interface RenderedDisplayItem extends DisplayItem {
  renderedMessage?: RenderedMarkdown;
  renderedResponse?: RenderedMarkdown;
}

@Component({
  selector: 'app-output-stream',
  standalone: true,
  imports: [DatePipe, MessageAttachmentsComponent, ThoughtProcessComponent, ToolGroupComponent, ContextMenuComponent],
  template: `
    @if (displayItems().length === 0) {
      <div class="empty-stream">
        <p>No messages yet</p>
        <p class="hint">Start a conversation</p>
      </div>
    } @else {
      <div class="output-stream" #container>
        @if (isLoadingOlder()) {
          <div class="load-more-skeleton">
            <div class="skeleton-line wide"></div>
            <div class="skeleton-line medium"></div>
            <div class="skeleton-line narrow"></div>
          </div>
        } @else if (hasOlderMessages()) {
          <button class="load-more-btn" (click)="loadOlderMessages()">Load earlier messages</button>
        }
        @if (hiddenToolGroupCount() > 0) {
          <button class="tool-calls-toggle" (click)="toggleToolCalls()">
            <span class="toggle-icon">{{ effectiveShowToolCalls() ? '▾' : '▸' }}</span>
            {{ hiddenToolGroupCount() }} tool call{{ hiddenToolGroupCount() !== 1 ? ' groups' : ' group' }} hidden
          </button>
        }
        @for (item of visibleItems(); track item.id; let i = $index) {
          <div class="transcript-item" [attr.data-item-index]="i" (contextmenu)="onContextMenu($event, item)">
          @if (item.type === 'thought-group') {
            @if (hasThoughtGroupContent(item)) {
              <div class="thought-group">
                @if ((item.thinking && item.thinking.length > 0) || (item.thoughts && item.thoughts.length > 0)) {
                  @if (showThinking()) {
                    <app-thought-process
                      [thoughts]="item.thoughts || []"
                      [thinkingBlocks]="item.thinking"
                      [defaultExpanded]="thinkingDefaultExpanded()"
                      [instanceId]="instanceId()"
                      [itemId]="item.id"
                    />
                  }
                }
                @if (item.response && hasContent(item.response)) {
                  <div class="message message-assistant" [class.continuation]="item.showHeader === false"
                    [title]="item.response.timestamp | date: 'HH:mm:ss'">
                    @if (item.showHeader !== false) {
                      <div class="message-header">
                        <span class="message-type">{{ getProviderDisplayName(provider()) }}</span>
                        <span class="message-time">{{ item.response.timestamp | date: 'HH:mm:ss' }}</span>
                      </div>
                    }
                    <div class="message-content">
                      <div class="markdown-content" [innerHTML]="item.renderedResponse"></div>
                      @if (item.response.attachments && item.response.attachments.length > 0) {
                        <app-message-attachments [attachments]="item.response.attachments" />
                      }
                    </div>
                  </div>
                  <div class="message-hover-actions">
                    <button class="action-btn" [class.copied]="isMessageCopied(item.response.id)"
                      (click)="copyMessageContent(item.response.content, item.response.id)"
                      title="Copy to clipboard">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                    </button>
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
            } @else if (isRestoreNotice(item.message)) {
              <div class="restore-notice">
                <svg class="restore-notice-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="12"></line>
                  <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
                <div class="restore-notice-content" [innerHTML]="item.renderedMessage"></div>
              </div>
            } @else if (hasContent(item.message)) {
              <div class="message" [class]="'message-' + item.message.type"
                [class.continuation]="item.showHeader === false"
                [title]="item.message.timestamp | date: 'HH:mm:ss'">
                @if (item.showHeader !== false && item.message.type !== 'user') {
                  <div class="message-header">
                    <span class="message-type">{{ formatType(item.message.type) }}</span>
                    @if (item.repeatCount && item.repeatCount > 1) {
                      <span class="repeat-badge">&times;{{ item.repeatCount }}</span>
                    }
                    <span class="message-time">{{ item.message.timestamp | date: 'HH:mm:ss' }}</span>
                    @if (item.message.type === 'assistant') {
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
                  @if (item.message.type === 'user') {
                    <span class="inline-timestamp">{{ item.message.timestamp | date: 'HH:mm' }}</span>
                  }
                </div>
              </div>
              @if (item.message.type === 'user') {
                <div class="message-hover-actions align-right">
                  <button class="action-btn" [class.copied]="isMessageCopied(item.message.id)"
                    (click)="copyMessageContent(item.message.content, item.message.id)"
                    title="Copy to clipboard">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  </button>
                </div>
              }
            }
          }
          </div>
        }
      </div>
    }

    <!-- Scroll to top button -->
    @if (showScrollToTop()) {
      <button class="scroll-to-top-btn" (click)="scrollToTop()" title="Scroll to top">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="18 15 12 9 6 15"></polyline>
        </svg>
      </button>
    }

    <!-- Scroll to bottom button -->
    @if (showScrollToBottom()) {
      <button class="scroll-to-bottom-btn" (click)="scrollToBottom()" title="Scroll to bottom">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
    }

    <app-context-menu
      [items]="contextMenuItems()"
      [x]="contextMenuX()"
      [y]="contextMenuY()"
      [visible]="contextMenuVisible()"
      (closed)="contextMenuVisible.set(false)"
    />
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        position: relative;
      }

      /* #7: Anchor content to bottom when conversation is short */
      .output-stream {
        flex: 1;
        min-height: 0;
        height: 100%;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 8px 12px 8px 4px;
        background: transparent;
        border-radius: 18px;
        position: relative;
        display: flex;
        flex-direction: column;
        /* Use margin-top:auto on first child instead of justify-content:flex-end
           to anchor short content to bottom without breaking scroll */
      }

      /* Push content to bottom when conversation is short */
      .transcript-item:first-child {
        margin-top: auto;
      }

      .transcript-item {
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
      }

      /* #1: Tighter vertical spacing */
      .message {
        width: 100%;
        max-width: none;
        min-width: 0;
        box-sizing: border-box;
        padding: 2px 0;
        border-radius: 0;
        background: transparent;
        border: none;
        box-shadow: none;
        margin-bottom: 4px;
      }

      /* #4: Continuation messages tuck tight */
      .message.continuation {
        margin-top: -2px;
        padding-top: 0;
      }

      /* User messages — right-aligned bubble, left-aligned text */
      .message-user {
        width: fit-content;
        max-width: 85%;
        margin-left: auto;
        padding: 10px 16px;
        text-align: left;
        background: rgba(255, 255, 255, 0.07);
        border: none;
        box-shadow: none;
        border-radius: 18px;
        color: var(--text-secondary);
      }

      /* User message content — flex layout for inline timestamp */
      .message-user .message-content {
        display: flex;
        flex-wrap: wrap;
        column-gap: 12px;
        row-gap: 2px;
      }

      .message-user .message-content > .markdown-content {
        flex: 0 0 auto;
        max-width: 100%;
        min-width: 0;
      }

      /* Inline timestamp — sits right of text, drops below when text is long */
      .inline-timestamp {
        flex-shrink: 0;
        margin-left: auto;
        align-self: flex-end;
        font-family: var(--font-mono);
        font-size: 9px;
        color: var(--text-muted);
        opacity: 0.5;
        line-height: 1;
        user-select: none;
      }

      .message-assistant {
        margin-right: auto;
        color: var(--text-primary);
      }

      /* #6: System messages — constrained width, centered */
      .message-system {
        width: fit-content;
        max-width: 90%;
        margin: 4px auto;
        padding: 8px 14px;
        background: rgba(var(--info-rgb), 0.06);
        border: 1px solid rgba(var(--info-rgb), 0.10);
        border-radius: 12px;
        font-size: 12px;
        color: var(--info-color);
      }

      .message-error {
        width: fit-content;
        max-width: 90%;
        margin: 4px auto;
        padding: 8px 14px;
        background: var(--error-bg);
        border: 1px solid rgba(var(--error-rgb), 0.16);
        border-radius: 12px;
        color: var(--error-color);
      }

      .message-tool_use,
      .message-tool_result {
        width: 100%;
        padding: 8px 10px;
        background: rgba(6, 10, 9, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 12px;
        font-size: 12px;
      }

      .repeat-badge {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-muted, #9ca3af);
        background: rgba(255, 255, 255, 0.06);
        padding: 1px 6px;
        border-radius: 10px;
        line-height: 1.2;
      }

      /* System messages: info tone (not alarming) */
      .message-system .repeat-badge {
        color: var(--info-color);
        background: rgba(var(--info-rgb), 0.12);
      }

      /* #5: Assistant label — smaller, subtler */
      .message-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        min-width: 0;
        margin-bottom: 2px;
        font-size: 9px;
      }

      .message-type {
        text-transform: uppercase;
        font-weight: 600;
        letter-spacing: 0.14em;
        opacity: 0.36;
        font-family: var(--font-mono);
        font-size: 8px;
      }

      /* #3: Timestamps hidden by default, shown on hover */
      .message-time {
        font-family: var(--font-mono);
        opacity: 0;
        margin-left: auto;
        font-size: 9px;
        transition: opacity var(--transition-fast);
      }

      .message:hover .message-time,
      .thought-group:hover .message-time {
        opacity: 0.32;
      }

      .copy-message-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 24px;
        height: 24px;
        padding: 0 4px;
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

      /* Hover action bar — appears below messages on hover */
      .message-hover-actions {
        display: flex;
        gap: 4px;
        padding: 4px 0 0;
        opacity: 0;
        transition: opacity var(--transition-fast);
      }

      .message-hover-actions.align-right {
        justify-content: flex-end;
      }

      .transcript-item:hover .message-hover-actions {
        opacity: 1;
      }

      .action-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        background: transparent;
        border: none;
        border-radius: var(--radius-sm);
        color: var(--text-muted);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          background: var(--bg-hover);
          color: var(--text-primary);
        }

        svg {
          flex-shrink: 0;
        }
      }

      .action-btn.copied {
        background: rgba(34, 197, 94, 0.12);
        color: #16a34a;
        border: 1px solid rgba(34, 197, 94, 0.4);
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

      /* #1: Tighter thought-group spacing */
      .thought-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
        width: 100%;
        max-width: none;
        min-width: 0;
        box-sizing: border-box;
        margin-right: auto;
        margin-bottom: 4px;
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

      .scroll-to-top-btn,
      .scroll-to-bottom-btn {
        position: absolute;
        right: 20px;
        width: 36px;
        height: 36px;
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

      .scroll-to-top-btn {
        top: 20px;
      }

      .scroll-to-bottom-btn {
        bottom: 20px;
      }

      /* Restore-fallback notice — amber callout for lost CLI context */
      .restore-notice {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        width: fit-content;
        max-width: 90%;
        margin: 8px auto;
        padding: 10px 16px;
        background: rgba(245, 158, 11, 0.06);
        border: 1px solid rgba(245, 158, 11, 0.14);
        border-radius: 12px;
        font-size: 12.5px;
        line-height: 1.5;
        color: rgba(245, 158, 11, 0.85);
      }

      .restore-notice-icon {
        flex-shrink: 0;
        margin-top: 2px;
        opacity: 0.7;
      }

      .restore-notice-content {
        min-width: 0;
      }

      .compaction-boundary {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        padding: 4px 0;
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

      .load-more-skeleton {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 16px 12px;
      }

      .skeleton-line {
        height: 12px;
        border-radius: 6px;
        background: linear-gradient(
          90deg,
          rgba(255, 255, 255, 0.03) 0%,
          rgba(255, 255, 255, 0.06) 50%,
          rgba(255, 255, 255, 0.03) 100%
        );
        background-size: 200% 100%;
        animation: skeleton-shimmer 1.5s ease-in-out infinite;
      }

      .skeleton-line.wide { width: 80%; }
      .skeleton-line.medium { width: 55%; }
      .skeleton-line.narrow { width: 35%; }

      @keyframes skeleton-shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }

      .load-more-btn {
        display: block;
        margin: 8px auto 12px;
        padding: 6px 16px;
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 16px;
        color: var(--text-muted);
        font-size: 12px;
        font-family: var(--font-mono);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          background: rgba(255, 255, 255, 0.04);
          border-color: rgba(255, 255, 255, 0.15);
          color: var(--text-secondary);
        }
      }

      .tool-calls-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 4px 0 8px;
        padding: 5px 12px;
        background: transparent;
        border: 1px dashed rgba(255, 255, 255, 0.06);
        border-radius: 12px;
        color: var(--text-muted);
        font-size: 11px;
        font-family: var(--font-mono);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          background: rgba(255, 255, 255, 0.03);
          border-color: rgba(255, 255, 255, 0.12);
          color: var(--text-secondary);
        }

        .toggle-icon {
          font-size: 9px;
          opacity: 0.6;
        }
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
  isChild = input<boolean>(false);

  container = viewChild<ElementRef<HTMLDivElement>>('container');

  /** Whether tool call groups are visible in the stream. Defaults to hidden for child instances. */
  showToolCalls = signal<boolean | null>(null); // null = use isChild default

  // Scroll state - stored per instance
  protected showScrollToTop = signal(false);
  protected showScrollToBottom = signal(false);
  private userScrolledUp = false;
  private scrollPositions = new Map<string, number>(); // instanceId -> scrollOffset
  private previousInstanceId: string | null = null;
  private lastAutoScrollInstanceId: string | null = null;
  private lastAutoScrollSignature = '';

  protected copiedMessageId = signal<string | null>(null);
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

  /** Whether tool calls are effectively shown (explicit toggle, or default based on isChild) */
  protected effectiveShowToolCalls = computed(() => {
    const explicit = this.showToolCalls();
    if (explicit !== null) return explicit;
    return !this.isChild();
  });

  /** Display items filtered by tool call visibility */
  protected visibleItems = computed<RenderedDisplayItem[]>(() => {
    const items = this.displayItems();
    if (this.effectiveShowToolCalls()) return items;
    return items.filter(item => item.type !== 'tool-group');
  });

  /** Count of hidden tool-group items (for the toggle bar) */
  protected hiddenToolGroupCount = computed(() => {
    if (this.effectiveShowToolCalls()) return 0;
    return this.displayItems().filter(item => item.type === 'tool-group').length;
  });

  constructor() {
    // Handle instance changes - save/restore scroll position
    effect(() => {
      const currentInstanceId = this.instanceId();
      const viewport = untracked(() => this.getViewportElement());

      if (this.previousInstanceId && this.previousInstanceId !== currentInstanceId && viewport) {
        // Save scroll position for the previous instance
        this.scrollPositions.set(this.previousInstanceId, viewport.scrollTop);
      }

      if (currentInstanceId !== this.previousInstanceId) {
        // Instance changed - reset scroll state
        this.userScrolledUp = false;
        this.showScrollToTop.set(false);
        this.showScrollToBottom.set(false);
        this.hasOlderMessages.set(false);
        this.isLoadingOlder.set(false);
        this.olderMessagesHiddenCount.set(0);
        this.lastAutoScrollInstanceId = currentInstanceId;
        this.lastAutoScrollSignature = this.getMessageSignature(this.messages());

        // Perf: measure thread switch time and transcript paint
        const stopSwitch = this.perf.markThreadSwitch(this.previousInstanceId, currentInstanceId);
        const stopPaint = this.perf.markTranscriptPaint(currentInstanceId, this.messages().length);

        // Restore scroll position for the new instance using rAF for frame alignment
        requestAnimationFrame(() => {
          const savedPosition = this.scrollPositions.get(currentInstanceId);
          const nextViewport = this.getViewportElement();
          if (nextViewport) {
            if (savedPosition !== undefined) {
              nextViewport.scrollTop = savedPosition;
              const distanceFromBottom =
                nextViewport.scrollHeight - nextViewport.scrollTop - nextViewport.clientHeight;
              this.userScrolledUp = distanceFromBottom > 100;
              this.showScrollToTop.set(savedPosition > 50);
              this.showScrollToBottom.set(distanceFromBottom > 50);
            } else {
              nextViewport.scrollTop = nextViewport.scrollHeight;
            }
          }
          stopPaint();
          stopSwitch();
        });

        this.previousInstanceId = currentInstanceId;

        // Probe backend to check if stored transcript exists for this instance
        this.probeForOlderMessages(currentInstanceId);
      }
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
        if (viewport && !this.userScrolledUp) {
          viewport.scrollTop = viewport.scrollHeight;
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
   * Setup scroll event listener to detect user scrolling.
   * Returns the element and bound listener so the caller can remove it on destroy.
   */
  private setupScrollListener(): { element: HTMLElement; listener: EventListener } | null {
    const el = this.getViewportElement();
    if (!el) return null;
    let lastScrollTime = 0;

    const listener: EventListener = () => {
      // Measure scroll frame timing for perf budget
      const now = performance.now();
      if (lastScrollTime > 0) {
        this.perf.recordScrollFrame(this.instanceId(), now - lastScrollTime, this.messages().length);
      }
      lastScrollTime = now;

      const scrollOffset = el.scrollTop;
      const viewportSize = el.clientHeight;
      const totalSize = el.scrollHeight;
      const autoScrollThreshold = 100;
      const buttonShowThreshold = 50;

      const distanceFromBottom = totalSize - scrollOffset - viewportSize;
      const distanceFromTop = scrollOffset;

      this.userScrolledUp = distanceFromBottom > autoScrollThreshold;
      this.showScrollToTop.set(distanceFromTop > buttonShowThreshold);
      this.showScrollToBottom.set(distanceFromBottom > buttonShowThreshold);
      this.scrollPositions.set(this.instanceId(), scrollOffset);

      // Trigger loading older messages when near the top
      if (distanceFromTop < 200 && !this.isLoadingOlder() && this.hasOlderMessages()) {
        this.loadOlderMessages();
      }
    };

    el.addEventListener('scroll', listener, { passive: true });
    return { element: el, listener };
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

    el.scrollTo({ top: 0, behavior: 'smooth' });
    this.showScrollToTop.set(false);
  }

  /**
   * Scroll to the bottom of the container
   */
  scrollToBottom(): void {
    const el = this.getViewportElement();
    if (!el) return;

    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    this.userScrolledUp = false;
    this.showScrollToBottom.set(false);
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

  isRestoreNotice(message: OutputMessage): boolean {
    return message.type === 'system' && !!message.metadata?.['isRestoreNotice'];
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

  onContextMenu(event: MouseEvent, item: DisplayItem): void {
    event.preventDefault();
    const menuItems = this.buildContextMenuItems(item);
    if (menuItems.length === 0) return;
    this.contextMenuX.set(event.clientX);
    this.contextMenuY.set(event.clientY);
    this.contextMenuItems.set(menuItems);
    this.contextMenuVisible.set(true);
  }

  private buildContextMenuItems(item: DisplayItem): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    const content = item.message?.content || item.response?.content;
    const forkableMessage = item.message ?? item.response;
    if (content) {
      items.push({
        label: 'Copy message',
        action: () => {
          navigator.clipboard.writeText(content);
          this.contextMenuVisible.set(false);
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
    this.contextMenuVisible.set(false);

    const result = await this.ipc.forkSession(instanceId, bufferIndex + 1, `Fork at message ${bufferIndex + 1}`);

    if (result?.success && result.data) {
      const data = result.data as { id?: string };
      if (data.id) {
        this.instanceStore.setSelectedInstance(data.id);
      }
    }
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
    const lastMessage = messages[messages.length - 1];
    return [
      messages.length,
      lastMessage?.id ?? '',
      lastMessage?.timestamp ?? '',
      lastMessage?.content?.length ?? 0
    ].join(':');
  }

}
