/**
 * System Event Group Component — collapsible panel showing a run of
 * orchestration system messages (e.g. repeated `get_children` polls) under
 * one accordion. Mirrors the visual treatment of <app-thought-process>.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import type { OutputMessage } from '../../../core/state/instance/instance.types';
import { ExpansionStateService } from '../../../features/instance-detail/expansion-state.service';
import { MarkdownService } from '../../../core/services/markdown.service';

@Component({
  selector: 'app-system-event-group',
  standalone: true,
  imports: [DatePipe],
  template: `
    <div class="system-event-group" [class.expanded]="isExpanded()">
      <button class="seg-header" (click)="toggle()" type="button">
        <span class="seg-icon">{{ isExpanded() ? '▼' : '▶' }}</span>
        <span class="seg-label">{{ label() }}</span>
        <span class="seg-count">({{ events().length }}×)</span>
        @if (preview()) {
          <span class="seg-preview" [title]="preview()">— {{ preview() }}</span>
        }
        <span class="seg-chevron">{{ isExpanded() ? '−' : '+' }}</span>
      </button>
      @if (isExpanded()) {
        <div class="seg-content">
          @for (event of events(); track event.id) {
            <div class="seg-event">
              <span class="seg-event-time">{{ event.timestamp | date: 'HH:mm:ss' }}</span>
              <div class="seg-event-body markdown-content"
                [innerHTML]="renderEvent(event.content)"></div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .system-event-group {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      overflow: hidden;
      margin: 4px auto;
    }

    .seg-header {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 10px 14px;
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 13px;
      color: var(--text-secondary);
      text-align: left;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .seg-icon {
      font-size: 10px;
      opacity: 0.6;
      width: 12px;
      flex-shrink: 0;
    }

    .seg-label {
      flex-shrink: 0;
      font-weight: 500;
    }

    .seg-count {
      flex-shrink: 0;
      font-size: 11px;
      color: var(--text-muted);
    }

    .seg-preview {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-muted);
      font-size: 12px;
    }

    .seg-chevron {
      flex-shrink: 0;
      font-size: 16px;
      opacity: 0.5;
      font-weight: 300;
    }

    .seg-content {
      min-width: 0;
      padding: 12px 14px 14px 34px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-secondary);
      border-top: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .seg-event {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }

    .seg-event-time {
      flex-shrink: 0;
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      color: var(--text-muted);
      padding-top: 2px;
      width: 64px;
    }

    .seg-event-body {
      flex: 1;
      min-width: 0;
      word-break: break-word;
    }

    .system-event-group.expanded .seg-header {
      color: var(--text-primary);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SystemEventGroupComponent {
  events = input.required<OutputMessage[]>();
  label = input.required<string>();
  preview = input.required<string>();
  instanceId = input.required<string>();
  itemId = input.required<string>();

  private expansionState = inject(ExpansionStateService);
  private markdown = inject(MarkdownService);

  isExpanded = computed(() =>
    this.expansionState.isExpanded(this.instanceId(), this.itemId()),
  );

  toggle(): void {
    this.expansionState.toggleExpanded(this.instanceId(), this.itemId());
  }

  /**
   * Render an event's markdown content. Called from the template; the markdown
   * service applies its own caching, so calling per-event on each change
   * detection cycle is acceptable for the small N of typical groups.
   */
  renderEvent(content: string): unknown {
    return this.markdown.render(content);
  }
}
