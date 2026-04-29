/**
 * Extended Thinking Panel Component
 *
 * Visualize Claude's extended thinking process:
 * - Collapsible thinking blocks
 * - Streaming animation during generation
 * - Token budget visualization
 * - Thinking depth indicators
 */

import {
  Component,
  input,
  signal,
  computed,
  ChangeDetectionStrategy,
  inject,
} from '@angular/core';
import { CLIPBOARD_SERVICE } from '../../../core/services/clipboard.service';

export interface ThinkingBlock {
  id: string;
  content: string;
  timestamp: number;
  tokenCount: number;
  depth: number;
  isComplete: boolean;
  summary?: string;
}

export interface ThinkingSession {
  sessionId: string;
  blocks: ThinkingBlock[];
  totalTokens: number;
  maxTokens: number;
  startTime: number;
  endTime?: number;
  isStreaming: boolean;
}

@Component({
  selector: 'app-extended-thinking-panel',
  standalone: true,
  template: `
    <div class="thinking-panel" [class.streaming]="session()?.isStreaming">
      <div class="panel-header" (click)="toggleCollapsed()" (keydown.enter)="toggleCollapsed()" (keydown.space)="toggleCollapsed()" tabindex="0" role="button">
        <div class="header-left">
          <span class="thinking-icon" [class.active]="session()?.isStreaming">🧠</span>
          <span class="panel-title">Extended Thinking</span>
          @if (session()?.isStreaming) {
            <span class="streaming-indicator">
              <span class="dot"></span>
              <span class="dot"></span>
              <span class="dot"></span>
            </span>
          }
        </div>
        <div class="header-right">
          @if (session()) {
            <span class="token-count">
              {{ formatTokens(session()!.totalTokens) }} / {{ formatTokens(session()!.maxTokens) }}
            </span>
            <div class="token-bar">
              <div
                class="token-fill"
                [style.width.%]="tokenUsagePercent()"
                [class.warning]="tokenUsagePercent() > 70"
                [class.danger]="tokenUsagePercent() > 90"
              ></div>
            </div>
          }
          <span class="collapse-icon">{{ isCollapsed() ? '▼' : '▲' }}</span>
        </div>
      </div>

      @if (!isCollapsed()) {
        <div class="panel-content">
          <!-- Thinking Depth Visualization -->
          @if (session() && session()!.blocks.length > 0) {
            <div class="depth-visualization">
              @for (block of session()!.blocks; track block.id) {
                <div
                  class="depth-marker"
                  [class.active]="!block.isComplete"
                  [style.height.px]="getDepthHeight(block.depth)"
                  [title]="'Depth ' + block.depth"
                ></div>
              }
            </div>
          }

          <!-- Thinking Blocks -->
          <div class="blocks-container">
            @for (block of session()?.blocks || []; track block.id; let i = $index) {
              <div
                class="thinking-block"
                [class.active]="!block.isComplete"
                [class.expanded]="expandedBlocks().has(block.id)"
                [style.--depth]="block.depth"
              >
                <div class="block-header" (click)="toggleBlock(block.id)" (keydown.enter)="toggleBlock(block.id)" (keydown.space)="toggleBlock(block.id)" tabindex="0" role="button">
                  <div class="block-info">
                    <span class="block-number">#{{ i + 1 }}</span>
                    <span class="block-depth">Depth {{ block.depth }}</span>
                    <span class="block-tokens">{{ block.tokenCount }} tokens</span>
                  </div>
                  @if (block.summary) {
                    <span class="block-summary">{{ block.summary }}</span>
                  }
                  <span class="expand-icon">
                    {{ expandedBlocks().has(block.id) ? '−' : '+' }}
                  </span>
                </div>

                @if (expandedBlocks().has(block.id)) {
                  <div class="block-content">
                    <pre class="thinking-text">{{ block.content }}</pre>
                  </div>
                }

                @if (!block.isComplete) {
                  <div class="streaming-overlay">
                    <span class="cursor"></span>
                  </div>
                }
              </div>
            }

            @if (!session() || session()!.blocks.length === 0) {
              <div class="empty-state">
                <span class="empty-icon">💭</span>
                <span class="empty-text">No thinking data yet</span>
              </div>
            }
          </div>

          <!-- Session Stats -->
          @if (session() && session()!.endTime) {
            <div class="session-stats">
              <div class="stat">
                <span class="stat-label">Duration</span>
                <span class="stat-value">{{ formatDuration((session()!.endTime ?? 0) - session()!.startTime) }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Blocks</span>
                <span class="stat-value">{{ session()!.blocks.length }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Max Depth</span>
                <span class="stat-value">{{ maxDepth() }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Tokens Used</span>
                <span class="stat-value">{{ formatTokens(session()!.totalTokens) }}</span>
              </div>
            </div>
          }

          <!-- Controls -->
          <div class="panel-controls">
            <button
              class="control-btn"
              (click)="expandAll()"
              [disabled]="!session() || session()!.blocks.length === 0"
            >
              Expand All
            </button>
            <button
              class="control-btn"
              (click)="collapseAll()"
              [disabled]="!session() || session()!.blocks.length === 0"
            >
              Collapse All
            </button>
            <button
              class="control-btn"
              (click)="copyThinking()"
              [disabled]="!session() || session()!.blocks.length === 0"
            >
              Copy All
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .thinking-panel {
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      overflow: hidden;
      border: 1px solid var(--border-color);
    }

    .thinking-panel.streaming {
      border-color: var(--primary-color);
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm) var(--spacing-md);
      cursor: pointer;
      transition: background var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .thinking-icon {
      font-size: 16px;
      transition: transform 0.3s ease;

      &.active {
        animation: pulse 1.5s ease-in-out infinite;
      }
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.1); }
    }

    .panel-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .streaming-indicator {
      display: flex;
      gap: 3px;
      margin-left: var(--spacing-sm);
    }

    .streaming-indicator .dot {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--primary-color);
      animation: bounce 1.4s ease-in-out infinite both;

      &:nth-child(1) { animation-delay: -0.32s; }
      &:nth-child(2) { animation-delay: -0.16s; }
    }

    @keyframes bounce {
      0%, 80%, 100% { transform: scale(0); }
      40% { transform: scale(1); }
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .token-count {
      font-size: 10px;
      font-family: var(--font-mono);
      color: var(--text-muted);
    }

    .token-bar {
      width: 60px;
      height: 4px;
      background: var(--bg-secondary);
      border-radius: 2px;
      overflow: hidden;
    }

    .token-fill {
      height: 100%;
      background: var(--primary-color);
      transition: width var(--transition-normal);

      &.warning {
        background: #f59e0b;
      }

      &.danger {
        background: #ef4444;
      }
    }

    .collapse-icon {
      font-size: 10px;
      color: var(--text-muted);
    }

    .panel-content {
      border-top: 1px solid var(--border-color);
    }

    .depth-visualization {
      display: flex;
      gap: 2px;
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
    }

    .depth-marker {
      width: 4px;
      min-height: 8px;
      background: var(--primary-color);
      border-radius: 2px;
      opacity: 0.5;
      transition: all var(--transition-fast);

      &.active {
        opacity: 1;
        animation: grow 0.5s ease infinite alternate;
      }
    }

    @keyframes grow {
      from { transform: scaleY(1); }
      to { transform: scaleY(1.2); }
    }

    .blocks-container {
      max-height: 400px;
      overflow-y: auto;
      padding: var(--spacing-sm);
    }

    .thinking-block {
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      margin-bottom: var(--spacing-sm);
      overflow: hidden;
      border-left: 3px solid transparent;
      border-left-color: hsl(calc(250 + var(--depth, 0) * 20), 70%, 60%);

      &.active {
        border-left-color: var(--primary-color);
      }
    }

    .block-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm);
      cursor: pointer;
      transition: background var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }
    }

    .block-info {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .block-number {
      font-size: 10px;
      font-weight: 600;
      color: var(--primary-color);
    }

    .block-depth {
      font-size: 9px;
      color: var(--text-muted);
      background: var(--bg-tertiary);
      padding: 2px 6px;
      border-radius: 4px;
    }

    .block-tokens {
      font-size: 9px;
      font-family: var(--font-mono);
      color: var(--text-muted);
    }

    .block-summary {
      flex: 1;
      font-size: 11px;
      color: var(--text-secondary);
      margin-left: var(--spacing-md);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .expand-icon {
      font-size: 14px;
      font-weight: bold;
      color: var(--text-muted);
      width: 20px;
      text-align: center;
    }

    .block-content {
      padding: var(--spacing-sm);
      background: var(--bg-tertiary);
      border-top: 1px solid var(--border-color);
    }

    .thinking-text {
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
    }

    .streaming-overlay {
      position: relative;
      padding: 0 var(--spacing-sm) var(--spacing-sm);
    }

    .cursor {
      display: inline-block;
      width: 2px;
      height: 14px;
      background: var(--primary-color);
      animation: blink 1s step-end infinite;
    }

    @keyframes blink {
      50% { opacity: 0; }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: var(--spacing-xl);
      color: var(--text-muted);
    }

    .empty-icon {
      font-size: 32px;
      opacity: 0.5;
      margin-bottom: var(--spacing-sm);
    }

    .empty-text {
      font-size: 12px;
    }

    .session-stats {
      display: flex;
      justify-content: space-around;
      padding: var(--spacing-sm) var(--spacing-md);
      border-top: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .stat {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }

    .stat-label {
      font-size: 9px;
      color: var(--text-muted);
      text-transform: uppercase;
    }

    .stat-value {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
      font-family: var(--font-mono);
    }

    .panel-controls {
      display: flex;
      justify-content: flex-end;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm) var(--spacing-md);
      border-top: 1px solid var(--border-color);
    }

    .control-btn {
      padding: 4px 8px;
      font-size: 10px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover:not(:disabled) {
        background: var(--bg-hover);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExtendedThinkingPanelComponent {
  private clipboard = inject(CLIPBOARD_SERVICE);

  /** Thinking session data */
  session = input<ThinkingSession | null>(null);

  /** Panel collapsed state */
  isCollapsed = signal<boolean>(false);

  /** Expanded blocks */
  expandedBlocks = signal<Set<string>>(new Set());

  /** Computed token usage percentage */
  tokenUsagePercent = computed(() => {
    const s = this.session();
    if (!s || s.maxTokens === 0) return 0;
    return Math.min(100, (s.totalTokens / s.maxTokens) * 100);
  });

  /** Computed max depth */
  maxDepth = computed(() => {
    const s = this.session();
    if (!s || s.blocks.length === 0) return 0;
    return Math.max(...s.blocks.map(b => b.depth));
  });

  toggleCollapsed(): void {
    this.isCollapsed.update(v => !v);
  }

  toggleBlock(blockId: string): void {
    this.expandedBlocks.update(set => {
      const newSet = new Set(set);
      if (newSet.has(blockId)) {
        newSet.delete(blockId);
      } else {
        newSet.add(blockId);
      }
      return newSet;
    });
  }

  expandAll(): void {
    const s = this.session();
    if (!s) return;
    this.expandedBlocks.set(new Set(s.blocks.map(b => b.id)));
  }

  collapseAll(): void {
    this.expandedBlocks.set(new Set());
  }

  async copyThinking(): Promise<void> {
    const s = this.session();
    if (!s) return;

    const text = s.blocks.map(b => `[Block ${b.depth}]\n${b.content}`).join('\n\n');
    const result = await this.clipboard.copyText(text, { label: 'thinking block' });
    if (!result.ok) {
      console.error('Failed to copy thinking blocks:', result.reason, result.cause);
    }
  }

  getDepthHeight(depth: number): number {
    return Math.min(40, 8 + depth * 8);
  }

  formatTokens(tokens: number): string {
    if (tokens >= 1000) {
      return (tokens / 1000).toFixed(1) + 'K';
    }
    return tokens.toString();
  }

  formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }
}
