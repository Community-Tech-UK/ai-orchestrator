import type { RenderedMarkdown } from './output-stream.types';

const MAX_CACHE_SIZE = 200;
const MAX_CACHEABLE_LENGTH = 50_000; // Skip caching very large content

/**
 * LRU cache around markdown rendering for the output stream.
 *
 * Keyed by messageId to avoid cache pollution from streaming intermediate
 * strings (falls back to the content itself when no id is available). A hit
 * requires the cached content to still match, so an in-place streaming update
 * under the same id re-renders. Perf is recorded only for actual renders.
 */
export class MarkdownRenderCache {
  private cache = new Map<string, { content: string; rendered: RenderedMarkdown }>();

  constructor(
    private readonly renderFn: (content: string) => RenderedMarkdown,
    private readonly recordRender: (contentLength: number, durationMs: number) => void,
  ) {}

  render(content: string, messageId?: string): RenderedMarkdown {
    if (!content) return '';

    const cacheKey = messageId || content;

    // Check cache first — LRU: delete and re-insert to move to end
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && cached.content === content) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached.rendered;
    }

    const renderStart = performance.now();
    const rendered = this.renderFn(content);
    this.recordRender(content.length, performance.now() - renderStart);

    if (content.length <= MAX_CACHEABLE_LENGTH) {
      // Evict oldest (first) entries if at capacity
      while (this.cache.size >= MAX_CACHE_SIZE) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
        else break;
      }
      this.cache.set(cacheKey, { content, rendered });
    }

    return rendered;
  }
}
