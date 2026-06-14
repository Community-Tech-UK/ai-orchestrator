import DOMPurify from 'dompurify';
import { marked } from 'marked';

const renderer = new marked.Renderer();
const renderCache = new Map<string, string>();
const RENDER_CACHE_LIMIT = 300;

renderer.link = ({ href, title, text }) => {
  const isExternal = href.startsWith('http://') || href.startsWith('https://');
  const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(href)}"${titleAttr}${target}>${text}</a>`;
};

renderer.image = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttr}>`;
};

renderer.table = ({ header, rows }) => {
  const headerHtml = header.map((cell) => `<th>${cell.text}</th>`).join('');
  const bodyHtml = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell.text}</td>`).join('')}</tr>`)
    .join('');

  return `<div class="md-table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
};

export function renderMobileMarkdown(content: string): string {
  if (!content) return '';
  const cached = renderCache.get(content);
  if (cached !== undefined) {
    renderCache.delete(content);
    renderCache.set(content, cached);
    return cached;
  }

  const rawHtml = marked.parse(content, {
    async: false,
    breaks: true,
    gfm: true,
    renderer,
  }) as string;

  const sanitized = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      'a',
      'blockquote',
      'br',
      'code',
      'del',
      'div',
      'em',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'img',
      'li',
      'ol',
      'p',
      'pre',
      's',
      'span',
      'strong',
      'table',
      'tbody',
      'td',
      'th',
      'thead',
      'tr',
      'ul',
    ],
    ALLOWED_ATTR: ['alt', 'class', 'href', 'rel', 'src', 'start', 'target', 'title', 'type', 'value'],
  });
  renderCache.set(content, sanitized);
  while (renderCache.size > RENDER_CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value;
    if (oldest === undefined) break;
    renderCache.delete(oldest);
  }
  return sanitized;
}

function escapeHtml(text: string): string {
  const escapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => escapes[char]);
}
