/**
 * Streaming Text Component
 *
 * Displays text with animated streaming effect:
 * - Character-by-character reveal
 * - Blinking cursor
 * - Markdown rendering support
 * - Auto-scroll capability
 */

import {
  Component,
  input,
  output,
  computed,
  signal,
  effect,
  OnDestroy,
  ChangeDetectionStrategy,
  ElementRef,
  ViewChild,
  AfterViewInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type { StreamingTextOptions } from '../../../../../shared/types/verification-ui.types';

@Component({
  selector: 'app-streaming-text',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      #container
      class="streaming-text"
      [class.with-cursor]="showCursor()"
      [class.markdown]="options().enableMarkdown"
    >
      <div class="content" [innerHTML]="displayContent()"></div>
      @if (showCursor() && isStreaming()) {
        <span class="cursor"></span>
      }
    </div>
  `,
  styles: [`
    .streaming-text {
      position: relative;
      font-family: inherit;
      line-height: 1.6;
      overflow-y: auto;
      max-height: var(--max-height, 400px);
    }

    .content {
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .streaming-text.markdown .content {
      white-space: normal;
    }

    .streaming-text.markdown .content :deep(h1),
    .streaming-text.markdown .content :deep(h2),
    .streaming-text.markdown .content :deep(h3) {
      margin-top: 1em;
      margin-bottom: 0.5em;
      font-weight: 600;
    }

    .streaming-text.markdown .content :deep(code) {
      background: var(--bg-tertiary, #1e1e1e);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 0.9em;
    }

    .streaming-text.markdown .content :deep(pre) {
      background: var(--bg-tertiary, #1e1e1e);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
    }

    .streaming-text.markdown .content :deep(pre code) {
      background: none;
      padding: 0;
    }

    .streaming-text.markdown .content :deep(ul),
    .streaming-text.markdown .content :deep(ol) {
      padding-left: 1.5em;
      margin: 0.5em 0;
    }

    .streaming-text.markdown .content :deep(blockquote) {
      border: 1px solid var(--border-color, #374151);
      border-radius: 6px;
      padding: 0.5em 1em;
      margin: 0.5em 0;
      background: var(--bg-tertiary, #1e1e1e);
      color: var(--text-secondary);
    }

    .cursor {
      display: inline-block;
      width: 2px;
      height: 1.2em;
      background: var(--accent-color, #3b82f6);
      margin-left: 2px;
      vertical-align: text-bottom;
      animation: blink 1s infinite;
    }

    @keyframes blink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0; }
    }

    .streaming-text::-webkit-scrollbar {
      width: 6px;
    }

    .streaming-text::-webkit-scrollbar-track {
      background: transparent;
    }

    .streaming-text::-webkit-scrollbar-thumb {
      background: var(--border-color, #374151);
      border-radius: 3px;
    }
  `],
})
export class StreamingTextComponent implements AfterViewInit, OnDestroy {
  @ViewChild('container') containerRef!: ElementRef<HTMLDivElement>;

  // Inputs
  text = input.required<string>();
  options = input<StreamingTextOptions>({
    enableMarkdown: true,
    showCursor: true,
    autoScroll: true,
    charDelay: 10,
  });
  isStreaming = input<boolean>(false);

  // Outputs
  streamComplete = output<void>();
  scrolledToBottom = output<void>();

  // Internal state
  private displayedLength = signal(0);
  private animationFrame: number | null = null;
  private lastText = '';

  // Computed values
  showCursor = computed(() => this.options().showCursor);

  displayContent = computed(() => {
    const fullText = this.text();
    const length = this.displayedLength();

    // If not streaming or animation complete, show full text
    if (!this.isStreaming() || length >= fullText.length) {
      return this.options().enableMarkdown
        ? this.parseMarkdown(fullText)
        : this.escapeHtml(fullText);
    }

    // Show animated portion
    const displayed = fullText.substring(0, length);
    return this.options().enableMarkdown
      ? this.parseMarkdown(displayed)
      : this.escapeHtml(displayed);
  });

  constructor() {
    // Effect to handle text changes and trigger animation
    effect(() => {
      const text = this.text();
      const streaming = this.isStreaming();

      if (streaming && text !== this.lastText) {
        // New text while streaming - animate the difference
        const startFrom = this.lastText.length;
        this.lastText = text;
        this.animateText(startFrom, text.length);
      } else if (!streaming) {
        // Not streaming - show full text immediately
        this.displayedLength.set(text.length);
        this.lastText = text;
      }
    });
  }

  ngAfterViewInit(): void {
    // Initial scroll to bottom if needed
    if (this.options().autoScroll) {
      this.scrollToBottom();
    }
  }

  ngOnDestroy(): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
  }

  // ============================================
  // Animation
  // ============================================

  private animateText(startFrom: number, endAt: number): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }

    const charDelay = this.options().charDelay || 10;
    let currentPos = startFrom;
    let lastTime = performance.now();

    const animate = (time: number) => {
      const elapsed = time - lastTime;

      if (elapsed >= charDelay) {
        currentPos += Math.floor(elapsed / charDelay);
        currentPos = Math.min(currentPos, endAt);
        this.displayedLength.set(currentPos);
        lastTime = time;

        if (this.options().autoScroll) {
          this.scrollToBottom();
        }

        if (currentPos >= endAt) {
          this.animationFrame = null;
          this.streamComplete.emit();
          return;
        }
      }

      this.animationFrame = requestAnimationFrame(animate);
    };

    this.animationFrame = requestAnimationFrame(animate);
  }

  private scrollToBottom(): void {
    if (this.containerRef?.nativeElement) {
      const el = this.containerRef.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.scrolledToBottom.emit();
    }
  }

  // ============================================
  // Markdown/HTML
  // ============================================

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private parseMarkdown(text: string): string {
    // Simple markdown parser for common patterns
    let html = this.escapeHtml(text);

    // Code blocks (must be before inline code)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Numbered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Blockquotes
    html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

    // Line breaks
    html = html.replace(/\n\n/g, '</p><p>');
    html = `<p>${html}</p>`;

    return html;
  }
}
