/**
 * Tool Group Component - Collapsible accordion for grouped tool use/result messages
 *
 * Groups consecutive tool_use and tool_result messages behind an expandable section,
 * reducing visual noise in the conversation stream.
 *
 * The collapsed header keeps only the expand control and a count of failed calls.
 * What the turn did overall is written once, under the turn, by the turn note
 * (src/shared/summarise-turn.ts), so this header does not repeat it.
 */

import { Component, input, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { OutputMessage } from '../../../core/state/instance.store';
import { ExpansionStateService } from '../../../features/instance-detail/expansion-state.service';
import { countFailedToolCalls } from '../../../../../shared/turn-tool-events';
import { AioTooltipDirective } from '../../tooltip/aio-tooltip.directive';
import { copyFor } from '../../tooltip/tooltip-copy';
import { SubagentUsageStore } from '../../../core/state/subagent-usage.store';

@Component({
  selector: 'app-tool-group',
  standalone: true,
  imports: [DatePipe, AioTooltipDirective],
  template: `
    <div class="tool-group" [class.expanded]="isExpanded()">
      <button
        class="tool-group-header"
        type="button"
        [attr.aria-expanded]="isExpanded()"
        [attr.aria-label]="controlLabel()"
        (click)="toggle()"
      >
        <span class="tool-icon" aria-hidden="true">{{ isExpanded() ? '▼' : '▶' }}</span>
        <span class="tool-label">Tool calls</span>
        @if (failedCount() > 0) {
          <span class="tool-failed">{{ failedCount() }} failed</span>
        }
        <span class="tool-chevron" aria-hidden="true">{{ isExpanded() ? '−' : '+' }}</span>
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
              @if (helperText(msg); as text) {
                <p class="helper-usage" tabindex="0" [appTooltip]="helperTooltip">{{ text }}</p>
              }
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

    .tool-failed {
      flex-shrink: 0;
      font-size: 11px;
      font-weight: 600;
      color: var(--error-color);
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
      font-weight: 600;
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

  readonly helperTooltip = copyFor('cost.subagentSize');
  private readonly helpers = inject(SubagentUsageStore);

  /** How big a helper agent got, for the Task and Agent rows; only a measured sample is shown. */
  helperText(message: OutputMessage): string | null {
    if (message.type !== 'tool_use' || !['Task', 'Agent'].includes(this.getToolName(message))) return null;
    const sample = this.helpers.sample(this.instanceId(), String(message.metadata?.['id'] ?? message.id));
    if (!sample) return null;
    const tokens = sample.finalContextTokens >= 1000 ? `${Math.round(sample.finalContextTokens / 1000)}K` : String(sample.finalContextTokens);
    const duration = sample.durationMs < 60000 ? `${Math.round(sample.durationMs / 1000)} sec` : `${Math.round(sample.durationMs / 60000)} min`;
    return `Helper agent · ${tokens} tokens${sample.final ? ' at the end' : ''} · ${sample.toolUses} tool calls · ${duration}${sample.final ? '' : ' · running'}`;
  }

  private expansionState = inject(ExpansionStateService);

  isExpanded = computed(() => this.expansionState.isExpanded(this.instanceId(), this.itemId()));

  /**
   * Calls in this group that failed: an edit or write that errored, or a command
   * that could not run or that the provider marked as a check and that exited
   * non-zero. A search that finds nothing is not a failure.
   */
  readonly failedCount = computed(() => countFailedToolCalls(this.toolMessages()));

  readonly controlLabel = computed(() => {
    const failed = this.failedCount();
    return failed > 0 ? `Tool calls, ${failed} failed` : 'Tool calls';
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
