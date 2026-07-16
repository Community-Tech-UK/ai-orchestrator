/**
 * Tool Group Component - Collapsible accordion for grouped tool use/result messages
 *
 * Groups consecutive tool_use and tool_result messages behind an expandable section,
 * reducing visual noise in the conversation stream.
 */

import { Component, input, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { OutputMessage } from '../../../core/state/instance.store';
import { ExpansionStateService } from '../../../features/instance-detail/expansion-state.service';

@Component({
  selector: 'app-tool-group',
  standalone: true,
  imports: [DatePipe],
  template: `
    <div class="tool-group" [class.expanded]="isExpanded()">
      <button
        class="tool-group-header"
        type="button"
        [attr.aria-expanded]="isExpanded()"
        [attr.aria-label]="summaryLabel()"
        (click)="toggle()"
      >
        <span class="tool-icon">{{ isExpanded() ? '▼' : '▶' }}</span>
        <span class="tool-label">{{ summaryLabel() }}</span>
        <span class="tool-time">
          {{ timeRange() }}
        </span>
        <span class="tool-chevron">{{ isExpanded() ? '−' : '+' }}</span>
      </button>
      @if (isExpanded()) {
        <div class="tool-group-content">
          @for (msg of toolMessages(); track $index) {
            <div class="tool-item" [class]="'tool-item-' + msg.type">
              <div class="tool-item-header">
                <span class="tool-item-type">{{
                  msg.type === 'tool_use' ? 'TOOL' : 'RESULT'
                }}</span>
                <span class="tool-item-name">{{ getToolName(msg) }}</span>
                <span class="tool-item-time">{{
                  msg.timestamp | date: 'HH:mm:ss'
                }}</span>
              </div>
              <pre class="tool-item-content"><code>{{ formatContent(msg) }}</code></pre>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .tool-group {
      width: min(100%, 1100px);
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 16px;
      overflow: hidden;
      font-size: 12px;
    }

    .tool-group-header {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 10px 12px;
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 12px;
      color: var(--text-secondary);
      text-align: left;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .tool-icon {
      font-size: 10px;
      opacity: 0.6;
      width: 12px;
    }

    .tool-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
      font-family: var(--font-mono);
      letter-spacing: 0.03em;
    }

    .tool-time {
      flex-shrink: 0;
      font-family: var(--font-mono);
      font-size: 10px;
      opacity: 0.42;
    }

    .tool-chevron {
      font-size: 12px;
      opacity: 0.45;
      font-weight: 600;
    }

    .tool-group-content {
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      display: flex;
      flex-direction: column;
      min-width: 0;
      gap: 8px;
      padding: 8px 10px 10px;
      background: rgba(255, 255, 255, 0.015);
    }

    .tool-item {
      background: rgba(6, 10, 9, 0.42);
      min-width: 0;
      padding: 8px 10px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 12px;
    }

    .tool-item-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
      font-size: 11px;
    }

    .tool-item-type {
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.05em;
      opacity: 0.6;
    }

    .tool-item-tool_use .tool-item-type {
      color: var(--primary-color, #3b82f6);
    }

    .tool-item-tool_result .tool-item-type {
      color: #10b981;
    }

    .tool-item-name {
      font-weight: 500;
      color: var(--text-primary);
    }

    .tool-item-time {
      margin-left: auto;
      font-family: var(--font-mono);
      opacity: 0.4;
    }

    .tool-item-content {
      margin: 0;
      padding: 6px 8px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 10px;
      font-size: 11px;
      line-height: 1.5;
      max-width: 100%;
      box-sizing: border-box;
      overflow-x: auto;
      max-height: 160px;
      overflow-y: auto;
      color: var(--text-secondary);
    }

    .tool-item-content code {
      font-family: var(--font-mono);
    }

    .tool-group.expanded {
      .tool-group-header {
        color: var(--text-primary);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolGroupComponent {
  toolMessages = input.required<OutputMessage[]>();
  instanceId = input<string>('');
  itemId = input<string>('');

  private expansionState = inject(ExpansionStateService);

  isExpanded = computed(() => this.expansionState.isExpanded(this.instanceId(), this.itemId()));

  /**
   * Actual tool-call count in this group — counts real `tool_use` messages,
   * never the combined tool_use+tool_result renderer wrapper count.
   */
  readonly toolCallCount = computed(
    () => this.toolMessages().filter((msg) => msg.type === 'tool_use').length,
  );

  /**
   * Total characters of actual tool-result content currently held by this
   * group's messages. Counts `content.length` on `tool_result` messages only
   * — never a fabricated or renderer-side estimate.
   */
  readonly resultCharacterCount = computed(() => this.toolMessages()
    .filter((msg) => msg.type === 'tool_result')
    .reduce((total, msg) => total + (msg.content?.length ?? 0), 0));

  /**
   * Count of results whose metadata explicitly reports externalization
   * (`metadata['externalized']` boolean). Returns `null` when no message in
   * the group carries that field at all, so the summary can omit the segment
   * rather than reporting a fabricated zero.
   */
  readonly externalizedResultCount = computed<number | null>(() => {
    const flags = this.toolMessages()
      .filter((msg) => msg.type === 'tool_result')
      .map((msg) => msg.metadata?.['externalized']);
    const hasExternalizationData = flags.some((flag) => typeof flag === 'boolean');
    return hasExternalizationData ? flags.filter((flag) => flag === true).length : null;
  });

  /**
   * Truthful collapsed summary, e.g. "44 calls · 900,532 characters · 25
   * results externalized". Every segment is a real count derived from the
   * messages this component received; the externalized segment is omitted
   * entirely when that data isn't present rather than showing a guessed 0.
   */
  summaryLabel = computed(() => {
    const callCount = this.toolCallCount();
    const characterCount = this.resultCharacterCount();
    const externalizedCount = this.externalizedResultCount();

    const parts = [
      `${callCount.toLocaleString('en-US')} call${callCount !== 1 ? 's' : ''}`,
      `${characterCount.toLocaleString('en-US')} character${characterCount !== 1 ? 's' : ''}`,
    ];
    if (externalizedCount !== null) {
      parts.push(`${externalizedCount.toLocaleString('en-US')} result${externalizedCount !== 1 ? 's' : ''} externalized`);
    }
    return parts.join(' · ');
  });

  /**
   * Time range of the group
   */
  timeRange = computed(() => {
    const msgs = this.toolMessages();
    if (msgs.length === 0) return '';

    const first = msgs[0];
    const last = msgs[msgs.length - 1];

    const formatTime = (ts: number) => {
      const d = new Date(ts);
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };

    if (first.timestamp === last.timestamp) {
      return formatTime(first.timestamp);
    }

    return `${formatTime(first.timestamp)}–${formatTime(last.timestamp)}`;
  });

  toggle(): void {
    this.expansionState.toggleExpanded(this.instanceId(), this.itemId());
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
}
