/**
 * Output Stream Component - Displays Claude's output messages
 */

import {
  Component,
  input,
  ElementRef,
  viewChild,
  effect,
  ChangeDetectionStrategy,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { OutputMessage } from '../../core/state/instance.store';

@Component({
  selector: 'app-output-stream',
  standalone: true,
  imports: [DatePipe],
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
                <pre class="code-block">{{ formatContent(message) }}</pre>
              } @else {
                <div class="text-content" [innerHTML]="formatMarkdown(message.content)"></div>
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
      font-family: var(--font-mono);
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
    }

    .text-content {
      white-space: pre-wrap;
      word-break: break-word;
    }

    .code-block {
      margin: 0;
      padding: var(--spacing-sm);
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      overflow-x: auto;
      font-size: 12px;
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
    return !!message.content?.trim();
  }

  formatContent(message: OutputMessage): string {
    if (message.metadata) {
      return JSON.stringify(message.metadata, null, 2);
    }
    return message.content || '';
  }

  formatMarkdown(content: string): string {
    // Defensive check for undefined/null content
    if (!content) {
      return '';
    }

    // Strip orchestration command blocks (internal commands shouldn't be shown to user)
    let cleaned = content.replace(
      /:::ORCHESTRATOR_COMMAND:::\s*[\s\S]*?\s*:::END_COMMAND:::/g,
      ''
    );

    // Also strip orchestrator response blocks
    cleaned = cleaned.replace(
      /\[Orchestrator Response\][\s\S]*?\[\/Orchestrator Response\]/g,
      ''
    );

    // Clean up extra whitespace left behind
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    // Basic markdown formatting - could be enhanced with a proper library
    return cleaned
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code-block"><code>$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }
}
