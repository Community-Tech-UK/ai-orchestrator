/**
 * Markdown Service - Rich markdown rendering with syntax highlighting
 *
 * Features:
 * - Full markdown parsing with marked
 * - Syntax highlighting for code blocks using highlight.js
 * - Secure HTML sanitization with DOMPurify
 * - Copy code button support
 */

import { Injectable } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked, type Tokens } from 'marked';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

@Injectable({
  providedIn: 'root',
})
export class MarkdownService {
  private initialized = false;

  constructor(private sanitizer: DomSanitizer) {
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

    // Custom code block rendering with syntax highlighting
    renderer.code = ({ text, lang }: Tokens.Code): string => {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      let highlighted: string;

      try {
        highlighted = hljs.highlight(text, { language }).value;
      } catch {
        highlighted = this.escapeHtml(text);
      }

      const languageLabel = language !== 'plaintext' ? language : '';
      const copyId = `copy-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

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
          <pre class="hljs" data-code-id="${copyId}"><code class="language-${language}">${highlighted}</code></pre>
        </div>
      `;
    };

    // Custom inline code rendering
    renderer.codespan = ({ text }: Tokens.Codespan): string => {
      return `<code class="inline-code">${this.escapeHtml(text)}</code>`;
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
        'data-copy-id', 'data-code-id',
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
  handleCopyClick(copyId: string): void {
    const codeElement = document.querySelector(`[data-code-id="${copyId}"] code`);
    const button = document.querySelector(`[data-copy-id="${copyId}"]`);

    if (codeElement && button) {
      const text = codeElement.textContent || '';
      navigator.clipboard.writeText(text).then(() => {
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
      });
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
        button.addEventListener('click', () => this.handleCopyClick(copyId));
      }
    });
  }
}
