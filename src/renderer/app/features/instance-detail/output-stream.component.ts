/**
 * Output Stream Component - Displays Claude's output messages with rich markdown rendering
 */

import {
  Component,
  input,
  ElementRef,
  viewChild,
  effect,
  inject,
  ChangeDetectionStrategy,
  afterNextRender,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { OutputMessage } from '../../core/state/instance.store';
import { MarkdownService } from '../../core/services/markdown.service';
import { MessageAttachmentsComponent } from '../../shared/components/message-attachments/message-attachments.component';

@Component({
  selector: 'app-output-stream',
  standalone: true,
  imports: [DatePipe, MessageAttachmentsComponent],
  template: `
    <div class="output-stream" #container>
      @for (message of messages(); track message.id) {
        @if (hasContent(message)) {
          <div class="message" [class]="'message-' + message.type">
            <div class="message-header">
              <span class="message-type">{{ formatType(message.type) }}</span>
              <span class="message-time">
                {{ message.timestamp | date:'HH:mm:ss' }}
              </span>
            </div>
            <div class="message-content">
              @if (message.type === 'tool_use' || message.type === 'tool_result') {
                <div class="code-block-wrapper">
                  <div class="code-block-header">
                    <span class="code-language">{{ getToolName(message) }}</span>
                  </div>
                  <pre class="hljs"><code>{{ formatContent(message) }}</code></pre>
                </div>
              } @else {
                <div class="markdown-content" [innerHTML]="renderMarkdown(message.content)"></div>
              }
              @if (message.attachments && message.attachments.length > 0) {
                <app-message-attachments [attachments]="message.attachments" />
              }
            </div>
          </div>
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
      color: white;
      margin-left: var(--spacing-xl);

      .markdown-content {
        color: inherit;
      }

      .markdown-content a {
        color: white;
        text-decoration: underline;
      }

      .inline-code {
        background: rgba(255, 255, 255, 0.2);
        color: white;
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
      justify-content: space-between;
      align-items: center;
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
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OutputStreamComponent {
  messages = input.required<OutputMessage[]>();
  instanceId = input.required<string>();

  container = viewChild<ElementRef>('container');

  private markdownService = inject(MarkdownService);

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
}
