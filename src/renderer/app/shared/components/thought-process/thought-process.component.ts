/**
 * Thought Process Component - Collapsible panel showing Claude's thinking
 *
 * Displays intermediate thinking steps in an expandable section,
 * similar to claude.ai's "Thought process" UI.
 *
 * Supports both legacy string[] thoughts and structured ThinkingContent blocks.
 */

import { Component, input, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import type { ThinkingContent } from '../../../../../shared/types/instance.types';

@Component({
  selector: 'app-thought-process',
  standalone: true,
  template: `
    <div class="thought-process" [class.expanded]="isExpanded()">
      <button class="thought-header" (click)="toggle()">
        <span class="thought-icon">{{ isExpanded() ? '▼' : '▶' }}</span>
        <span class="thought-label">{{ displayLabel() }}</span>
        @if (thinkingBlocks()?.length) {
          <span class="thought-count">({{ thinkingBlocks()!.length }})</span>
        }
        <span class="thought-chevron">{{ isExpanded() ? '−' : '+' }}</span>
      </button>
      @if (isExpanded()) {
        <div class="thought-content">
          @if (thinkingBlocks()?.length) {
            <!-- Structured thinking blocks -->
            @for (block of thinkingBlocks(); track block.id) {
              <div class="thought-block" [class]="'format-' + block.format">
                @if (thinkingBlocks()!.length > 1) {
                  <div class="block-header">
                    <span class="block-format">{{ formatLabel(block.format) }}</span>
                  </div>
                }
                <div class="thought-item">{{ block.content }}</div>
              </div>
            }
          } @else {
            <!-- Legacy: string array -->
            @for (thought of thoughts(); track $index) {
              <div class="thought-item">{{ thought }}</div>
            }
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .thought-process {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 8px;
    }

    .thought-header {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
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

    .thought-icon {
      font-size: 10px;
      opacity: 0.6;
      width: 12px;
    }

    .thought-label {
      flex: 1;
      font-weight: 500;
    }

    .thought-count {
      font-size: 11px;
      color: var(--text-muted);
      margin-left: 4px;
    }

    .thought-chevron {
      font-size: 16px;
      opacity: 0.5;
      font-weight: 300;
    }

    .thought-content {
      padding: 0 14px 14px 34px;
      font-size: 13px;
      line-height: 1.6;
      color: var(--text-secondary);
      border-top: 1px solid var(--border-color);
      padding-top: 12px;
      margin-top: 0;
    }

    .thought-block {
      margin-bottom: 12px;

      &:last-child {
        margin-bottom: 0;
      }
    }

    .block-header {
      font-size: 10px;
      color: var(--text-muted);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .format-structured .block-header { color: var(--primary-color, #3b82f6); }
    .format-sdk .block-header { color: #10b981; }
    .format-xml .block-header { color: #f59e0b; }
    .format-header .block-header { color: #8b5cf6; }
    .format-bracket .block-header { color: #ec4899; }

    .thought-item {
      padding: 6px 0;
      white-space: pre-wrap;
      word-break: break-word;

      &:not(:last-child) {
        border-bottom: 1px dashed var(--border-color);
        padding-bottom: 10px;
        margin-bottom: 4px;
      }
    }

    .thought-process.expanded {
      .thought-header {
        color: var(--text-primary);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThoughtProcessComponent {
  // Legacy input: string array
  thoughts = input<string[]>([]);

  // New input: Structured thinking blocks
  thinkingBlocks = input<ThinkingContent[] | undefined>(undefined);

  label = input<string>('Thought process');
  defaultExpanded = input<boolean>(false);

  isExpanded = signal(false);

  /**
   * Computed label that auto-generates from first thinking block if no custom label
   */
  displayLabel = computed(() => {
    if (this.label() !== 'Thought process') {
      return this.label();
    }

    // Generate label from first thinking block
    const blocks = this.thinkingBlocks();
    if (blocks?.length) {
      const firstContent = blocks[0].content;
      const firstLine = firstContent.split('\n')[0].trim();
      return firstLine.length > 50 ? firstLine.slice(0, 47) + '...' : firstLine;
    }

    // Legacy: generate from string thoughts
    const thoughtsList = this.thoughts();
    if (thoughtsList?.length) {
      const firstLine = thoughtsList[0].split('\n')[0].trim();
      return firstLine.length > 50 ? firstLine.slice(0, 47) + '...' : firstLine;
    }

    return 'Thought process';
  });

  constructor() {
    // Initialize expanded state from input
    setTimeout(() => {
      this.isExpanded.set(this.defaultExpanded());
    });
  }

  toggle(): void {
    this.isExpanded.update(v => !v);
  }

  /**
   * Get human-readable label for thinking format
   */
  formatLabel(format: string): string {
    const labels: Record<string, string> = {
      structured: 'API Thinking',
      sdk: 'Reasoning',
      xml: 'Thinking',
      bracket: 'Analysis',
      header: 'Planning',
      unknown: 'Thought'
    };
    return labels[format] || 'Thought';
  }
}
