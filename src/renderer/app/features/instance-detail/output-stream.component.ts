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
  afterNextRender,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { OutputMessage } from '../../core/state/instance.store';
import { MarkdownService } from '../../core/services/markdown.service';
import { MessageAttachmentsComponent } from '../../shared/components/message-attachments/message-attachments.component';
import { ThoughtProcessComponent } from '../../shared/components/thought-process/thought-process.component';

/**
 * Represents a grouped display item - either a single message or a group of thinking messages
 */
interface DisplayItem {
  type: 'message' | 'thought-group';
  message?: OutputMessage;
  thoughts?: string[];
  response?: OutputMessage;
  timestamp?: number;
}

@Component({
  selector: 'app-output-stream',
  standalone: true,
  imports: [DatePipe, MessageAttachmentsComponent, ThoughtProcessComponent],
  template: `
    <div class="output-stream" #container>
      @for (item of displayItems(); track $index) {
        @if (item.type === 'thought-group') {
          <!-- Thought group with collapsible thinking section -->
          <div class="thought-group">
            @if (item.thoughts && item.thoughts.length > 0) {
              <app-thought-process
                [thoughts]="item.thoughts"
                [label]="getThoughtLabel(item.thoughts)"
              />
            }
            @if (item.response) {
              <div class="message message-assistant">
                <div class="message-header">
                  <span class="message-type">Claude</span>
                  <span class="message-time">
                    {{ item.response.timestamp | date:'HH:mm:ss' }}
                  </span>
                  <button
                    class="copy-message-btn"
                    (click)="copyMessageContent(item.response.content)"
                    title="Copy to clipboard"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  </button>
                </div>
                <div class="message-content">
                  <div class="markdown-content" [innerHTML]="renderMarkdown(item.response.content)"></div>
                  @if (item.response.attachments && item.response.attachments.length > 0) {
                    <app-message-attachments [attachments]="item.response.attachments" />
                  }
                </div>
              </div>
            }
          </div>
        } @else if (item.message) {
          <!-- Regular message -->
          @if (hasContent(item.message)) {
            <div class="message" [class]="'message-' + item.message.type">
              <div class="message-header">
                <span class="message-type">{{ formatType(item.message.type) }}</span>
                <span class="message-time">
                  {{ item.message.timestamp | date:'HH:mm:ss' }}
                </span>
                @if (item.message.type === 'user' || item.message.type === 'assistant') {
                  <button
                    class="copy-message-btn"
                    (click)="copyMessageContent(item.message.content)"
                    title="Copy to clipboard"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  </button>
                }
              </div>
              <div class="message-content">
                @if (item.message.type === 'tool_use' || item.message.type === 'tool_result') {
                  <div class="code-block-wrapper">
                    <div class="code-block-header">
                      <span class="code-language">{{ getToolName(item.message) }}</span>
                    </div>
                    <pre class="hljs"><code>{{ formatContent(item.message) }}</code></pre>
                  </div>
                } @else {
                  <div class="markdown-content" [innerHTML]="renderMarkdown(item.message.content)"></div>
                }
                @if (item.message.attachments && item.message.attachments.length > 0) {
                  <app-message-attachments [attachments]="item.message.attachments" />
                }
              </div>
            </div>
          }
        }
      } @empty {
        <div class="empty-stream">
          <p>No messages yet</p>
          <p class="hint">Start a conversation with Claude</p>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .output-stream {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: var(--spacing-md);
      background: var(--bg-secondary);
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .message {
      padding: var(--spacing-md);
      border-radius: var(--radius-md);
      background: var(--bg-tertiary);
    }

    .message-user {
      background: var(--primary-color);
      color: #1a1a1a;
      margin-left: var(--spacing-xl);

      .message-type,
      .message-time {
        color: rgba(26, 26, 26, 0.7);
      }

      .markdown-content {
        color: #1a1a1a;

        /* Ensure all text elements are black on orange */
        h1, h2, h3, h4, h5, h6,
        p, li, strong, em, b, i {
          color: #1a1a1a;
        }

        ul, ol {
          color: #1a1a1a;
        }

        li::marker {
          color: #1a1a1a;
        }

        a {
          color: #1a1a1a;
          text-decoration: underline;
        }

        .inline-code {
          background: rgba(0, 0, 0, 0.12);
          color: #1a1a1a;
          border-color: rgba(0, 0, 0, 0.2);
        }
      }

      /* Text selection highlight on orange background */
      ::selection {
        background: rgba(0, 0, 0, 0.3);
        color: #fff;
      }

      ::-moz-selection {
        background: rgba(0, 0, 0, 0.3);
        color: #fff;
      }

      .copy-message-btn {
        color: rgba(26, 26, 26, 0.6);

        &:hover {
          color: #1a1a1a;
          background: rgba(0, 0, 0, 0.1);
        }
      }
    }

    .message-assistant {
      background: var(--bg-tertiary);
      margin-right: var(--spacing-xl);
    }

    .message-system {
      background: var(--info-bg);
      font-size: 13px;
      color: var(--info-color);
    }

    .message-error {
      background: var(--error-bg);
      color: var(--error-color);
    }

    .message-tool_use,
    .message-tool_result {
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      font-size: 12px;
    }

    .message-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-xs);
      font-size: 12px;
    }

    .message-type {
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.05em;
      opacity: 0.7;
    }

    .message-time {
      font-family: var(--font-mono);
      opacity: 0.5;
      margin-left: auto;
    }

    .copy-message-btn {
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

    .message:hover .copy-message-btn {
      opacity: 1;
    }

    .message-content {
      line-height: 1.6;
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
      margin-right: var(--spacing-xl);
    }

    .thought-group .message-assistant {
      margin-right: 0;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OutputStreamComponent {
  messages = input.required<OutputMessage[]>();
  instanceId = input.required<string>();

  container = viewChild<ElementRef>('container');

  private markdownService = inject(MarkdownService);

  /**
   * Shows all messages without grouping - simple 1:1 display.
   */
  displayItems = computed<DisplayItem[]>(() => {
    const messages = this.messages();
    const items: DisplayItem[] = [];

    // Debug: log all messages to console
    console.log('[OutputStream] All messages:', messages.map(m => ({
      type: m.type,
      contentLength: m.content?.length || 0,
      contentPreview: m.content?.slice(0, 100) || '',
      timestamp: m.timestamp,
    })));

    for (const msg of messages) {
      // Show every message as-is
      items.push({
        type: 'message',
        message: msg,
      });
    }

    return items;
  });

  constructor() {
    // Auto-scroll to bottom when new messages arrive
    effect(() => {
      const msgs = this.messages();
      const el = this.container()?.nativeElement;
      if (el && msgs.length > 0) {
        // Use setTimeout to ensure DOM is updated
        setTimeout(() => {
          el.scrollTop = el.scrollHeight;
        }, 0);
      }
    });

    // Setup copy handlers after render
    afterNextRender(() => {
      this.setupCopyHandlers();
    });

    // Re-setup copy handlers when messages change
    effect(() => {
      this.messages(); // Track message changes
      setTimeout(() => this.setupCopyHandlers(), 100);
    });
  }

  /**
   * Setup click handlers for copy buttons
   */
  private setupCopyHandlers(): void {
    const el = this.container()?.nativeElement;
    if (el) {
      this.markdownService.setupCopyHandlers(el);
    }
  }

  /**
   * Copy message content to clipboard
   */
  copyMessageContent(content: string): void {
    if (!content) return;

    navigator.clipboard.writeText(content).then(() => {
      // Visual feedback could be added here if needed
      console.log('Message copied to clipboard');
    }).catch(err => {
      console.error('Failed to copy message:', err);
    });
  }

  formatType(type: string): string {
    const labels: Record<string, string> = {
      assistant: 'Claude',
      user: 'You',
      system: 'System',
      tool_use: 'Tool',
      tool_result: 'Result',
      error: 'Error',
    };
    return labels[type] || type;
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

  renderMarkdown(content: string): ReturnType<MarkdownService['render']> {
    return this.markdownService.render(content);
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
