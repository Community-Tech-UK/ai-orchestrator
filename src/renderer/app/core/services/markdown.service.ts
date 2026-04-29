/**
 * Markdown Service - Rich markdown rendering with syntax highlighting
 *
 * Features:
 * - Full markdown parsing with marked
 * - Syntax highlighting for code blocks using highlight.js
 * - Secure HTML sanitization with DOMPurify
 * - Copy code button support
 */

import { Injectable, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked, type Tokens } from 'marked';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import { detectLinks } from '../../../../shared/utils/link-detection';
import { CLIPBOARD_SERVICE } from './clipboard.service';

@Injectable({
  providedIn: 'root',
})
export class MarkdownService {
  private sanitizer = inject(DomSanitizer);
  private clipboard = inject(CLIPBOARD_SERVICE);
  private initialized = false;

  constructor() {
    this.initializeMarked();
  }

  /**
   * Initialize marked with custom renderer and options
   */
  private initializeMarked(): void {
    if (this.initialized) return;

    // Configure DOMPurify to allow specific elements and attributes
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      // Allow data attributes for copy functionality
      if (node.hasAttribute('data-copy-id') || node.hasAttribute('data-code-id')) {
        return;
      }
    });

    // Custom renderer for syntax highlighting
    const renderer = new marked.Renderer();

    // Code blocks: render escaped text immediately, defer syntax highlighting to idle time
    renderer.code = ({ text, lang }: Tokens.Code): string => {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      const escaped = this.escapeHtml(text);
      const languageLabel = language !== 'plaintext' ? language : '';
      const copyId = `copy-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const highlightAttr = language !== 'plaintext' ? ` data-highlight-lang="${language}"` : '';

      return `
        <div class="code-block-wrapper">
          <div class="code-block-header">
            <span class="code-language">${languageLabel}</span>
            <button class="copy-button" data-copy-id="${copyId}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              Copy
            </button>
          </div>
          <pre class="hljs" data-code-id="${copyId}"${highlightAttr}><code class="language-${language}">${escaped}</code></pre>
        </div>
      `;
    };

    // Custom inline code rendering - detect file paths and make them clickable
    renderer.codespan = ({ text }: Tokens.Codespan): string => {
      const escapedText = this.escapeHtml(text);

      const ranges = detectLinks(text, { kinds: ['file-path'] });
      const isFilePath =
        ranges.length === 1 &&
        ranges[0].start === 0 &&
        ranges[0].end === text.length;

      if (isFilePath) {
        // Make file paths clickable
        return `<code class="inline-code file-path" data-file-path="${escapedText}" title="Click to open file">${escapedText}</code>`;
      }

      return `<code class="inline-code">${escapedText}</code>`;
    };

    // Custom link rendering with target="_blank" for external links
    renderer.link = ({ href, title, text }: Tokens.Link): string => {
      const isExternal = href.startsWith('http://') || href.startsWith('https://');
      const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
      const titleAttr = title ? ` title="${this.escapeHtml(title)}"` : '';
      return `<a href="${this.escapeHtml(href)}"${titleAttr}${target}>${text}</a>`;
    };

    // Custom blockquote rendering
    renderer.blockquote = ({ text }: Tokens.Blockquote): string => {
      return `<blockquote class="md-blockquote">${text}</blockquote>`;
    };

    // Custom table rendering
    renderer.table = ({ header, rows }: Tokens.Table): string => {
      const headerHtml = header
        .map((cell) => `<th>${cell.text}</th>`)
        .join('');
      const bodyHtml = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${cell.text}</td>`).join('')}</tr>`)
        .join('');

      return `
        <div class="table-wrapper">
          <table class="md-table">
            <thead><tr>${headerHtml}</tr></thead>
            <tbody>${bodyHtml}</tbody>
          </table>
        </div>
      `;
    };

    // Configure marked
    marked.setOptions({
      renderer,
      gfm: true,
      breaks: true,
    });

    this.initialized = true;
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    const htmlEscapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return text.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
  }

  /**
   * Strip orchestration command blocks from content
   */
  private stripOrchestrationCommands(content: string): string {
    let cleaned = content;

    // Strip orchestration command blocks
    cleaned = cleaned.replace(
      /:::ORCHESTRATOR_COMMAND:::\s*[\s\S]*?\s*:::END_COMMAND:::/g,
      ''
    );

    // Strip orchestrator response blocks
    cleaned = cleaned.replace(
      /\[Orchestrator Response\][\s\S]*?\[\/Orchestrator Response\]/g,
      ''
    );

    // Clean up extra whitespace
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    return cleaned;
  }

  /**
   * Sanitize HTML using DOMPurify
   */
  private sanitizeHtml(html: string): string {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'p', 'br', 'hr',
        'strong', 'em', 'b', 'i', 'u', 's', 'del',
        'ul', 'ol', 'li',
        'a',
        'code', 'pre',
        'blockquote',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'div', 'span',
        'img',
        'button',
        'svg', 'rect', 'path', 'polyline',
      ],
      ALLOWED_ATTR: [
        'href', 'title', 'target', 'rel',
        'class',
        'data-copy-id', 'data-code-id', 'data-file-path', 'data-link-kind',
        'src', 'alt', 'width', 'height',
        'viewBox', 'fill', 'stroke', 'stroke-width',
        'x', 'y', 'rx', 'ry', 'd', 'points',
      ],
      ALLOW_DATA_ATTR: true,
    });
  }

  /**
   * Render markdown content to SafeHtml
   */
  render(content: string): SafeHtml {
    if (!content) {
      return this.sanitizer.bypassSecurityTrustHtml('');
    }

    // Clean content
    const cleaned = this.stripOrchestrationCommands(content);

    // Parse markdown
    const rawHtml = marked.parse(cleaned) as string;

    // Sanitize HTML with DOMPurify
    const sanitizedHtml = this.sanitizeHtml(rawHtml);

    // Return as SafeHtml for Angular
    return this.sanitizer.bypassSecurityTrustHtml(sanitizedHtml);
  }

  /**
   * Render markdown content synchronously (returns sanitized string)
   */
  renderSync(content: string): string {
    if (!content) {
      return '';
    }

    const cleaned = this.stripOrchestrationCommands(content);
    const rawHtml = marked.parse(cleaned) as string;
    return this.sanitizeHtml(rawHtml);
  }

  /**
   * Handle copy button click - call this when copy buttons are clicked
   */
  async handleCopyClick(copyId: string): Promise<void> {
    const codeElement = document.querySelector(`[data-code-id="${copyId}"] code`);
    const button = document.querySelector(`[data-copy-id="${copyId}"]`);

    if (codeElement && button) {
      const text = codeElement.textContent || '';
      const result = await this.clipboard.copyText(text, { label: 'code' });
      if (result.ok) {
        const originalHtml = button.innerHTML;
        button.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          Copied!
        `;
        button.classList.add('copied');

        setTimeout(() => {
          button.innerHTML = originalHtml;
          button.classList.remove('copied');
        }, 2000);
      } else {
        console.error('Failed to copy code block:', result.reason, result.cause);
      }
    }
  }

  /**
   * Setup click handlers for copy buttons in a container
   */
  setupCopyHandlers(container: HTMLElement): void {
    const buttons = container.querySelectorAll('.copy-button[data-copy-id]');
    buttons.forEach((button) => {
      const copyId = button.getAttribute('data-copy-id');
      if (copyId) {
        button.addEventListener('click', () => { void this.handleCopyClick(copyId); });
      }
    });
  }

  /**
   * Highlight code blocks in a container asynchronously using requestIdleCallback.
   * Blocks are processed incrementally so input events are never starved.
   */
  highlightCodeBlocksInElement(container: HTMLElement): void {
    const blocks = Array.from(container.querySelectorAll<HTMLPreElement>('pre[data-highlight-lang]'));
    if (blocks.length === 0) return;

    let index = 0;
    const highlightBatch = (deadline: IdleDeadline) => {
      while (index < blocks.length && deadline.timeRemaining() > 2) {
        const pre = blocks[index];
        const lang = pre.getAttribute('data-highlight-lang');
        const codeEl = pre.querySelector('code');
        if (lang && codeEl) {
          this.applyHighlight(codeEl, lang);
        }
        pre.removeAttribute('data-highlight-lang');
        index++;
      }
      if (index < blocks.length) {
        requestIdleCallback(highlightBatch);
      }
    };

    requestIdleCallback(highlightBatch);
  }

  // hljs.highlight produces safe HTML (only <span class="hljs-*"> from plain text input)
  private applyHighlight(codeEl: Element, lang: string): void {
    try {
      const result = hljs.highlight(codeEl.textContent || '', { language: lang });
      codeEl.innerHTML = result.value;
    } catch {
      // keep escaped text on failure
    }
  }

  /**
   * Setup click handlers for file path elements in a container
   */
  setupFilePathHandlers(container: HTMLElement, onFileClick: (filePath: string) => void): void {
    const filePaths = container.querySelectorAll('.file-path[data-file-path]');
    filePaths.forEach((element) => {
      const filePath = element.getAttribute('data-file-path');
      if (filePath && !element.hasAttribute('data-handler-attached')) {
        element.setAttribute('data-handler-attached', 'true');
        element.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          onFileClick(filePath);
        });
      }
    });
  }
}
