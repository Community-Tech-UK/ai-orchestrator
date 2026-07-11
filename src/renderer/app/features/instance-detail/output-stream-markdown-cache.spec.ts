/**
 * MarkdownRenderCache spec
 *
 * Tests:
 *   1. A repeat render with the same id and content is a cache hit (renderFn
 *      called once, perf recorded once).
 *   2. Same id with changed content (streaming update) re-renders.
 *   3. Content above the cacheable length is rendered but never cached.
 *   4. LRU eviction: oldest entry falls out at capacity; a recent hit is
 *      protected by move-to-end.
 *   5. Empty content short-circuits without rendering.
 */

import { describe, expect, it, vi } from 'vitest';
import { MarkdownRenderCache } from './output-stream-markdown-cache';

function makeCache() {
  const renderFn = vi.fn((content: string) => `<p>${content.length}</p>`);
  const recordRender = vi.fn();
  return { cache: new MarkdownRenderCache(renderFn, recordRender), renderFn, recordRender };
}

describe('MarkdownRenderCache', () => {
  it('serves a repeat render from cache and records perf only for the real render', () => {
    const { cache, renderFn, recordRender } = makeCache();

    const first = cache.render('hello', 'msg-1');
    const second = cache.render('hello', 'msg-1');

    expect(second).toBe(first);
    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(recordRender).toHaveBeenCalledTimes(1);
  });

  it('re-renders when content changes under the same message id', () => {
    const { cache, renderFn } = makeCache();

    cache.render('partial', 'msg-1');
    cache.render('partial plus more', 'msg-1');

    expect(renderFn).toHaveBeenCalledTimes(2);
  });

  it('renders oversized content without caching it', () => {
    const { cache, renderFn } = makeCache();
    const huge = 'x'.repeat(50_001);

    cache.render(huge, 'msg-big');
    cache.render(huge, 'msg-big');

    expect(renderFn).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry at capacity but keeps a recently-hit one', () => {
    const { cache, renderFn } = makeCache();

    for (let i = 0; i < 200; i++) {
      cache.render(`content-${i}`, `msg-${i}`);
    }
    // Touch msg-0 so it moves to the end of the LRU order.
    cache.render('content-0', 'msg-0');
    expect(renderFn).toHaveBeenCalledTimes(200);

    // Inserting one more evicts the oldest untouched entry (msg-1), not msg-0.
    cache.render('content-200', 'msg-200');
    cache.render('content-0', 'msg-0');
    expect(renderFn).toHaveBeenCalledTimes(201); // msg-0 still cached

    cache.render('content-1', 'msg-1');
    expect(renderFn).toHaveBeenCalledTimes(202); // msg-1 was evicted
  });

  it('promotes a streaming-updated entry so it is not evicted before older untouched ones', () => {
    const { cache, renderFn } = makeCache();

    for (let i = 0; i < 200; i++) {
      cache.render(`content-${i}`, `msg-${i}`);
    }
    expect(renderFn).toHaveBeenCalledTimes(200);

    // Streaming update to the OLDEST entry: same id, changed content (a cache miss). This
    // must move it to the most-recent position — Map.set on an existing key would otherwise
    // leave it at its original slot and let it be evicted as "oldest" despite recent activity.
    cache.render('content-0 updated', 'msg-0');
    expect(renderFn).toHaveBeenCalledTimes(201);

    // One fresh insert evicts the now-oldest untouched entry (msg-1), NOT the updated msg-0.
    cache.render('content-200', 'msg-200');

    cache.render('content-0 updated', 'msg-0');
    expect(renderFn).toHaveBeenCalledTimes(202); // msg-0 still cached at its updated content

    cache.render('content-1', 'msg-1');
    expect(renderFn).toHaveBeenCalledTimes(203); // msg-1 was the one evicted
  });

  it('returns empty output for empty content without rendering', () => {
    const { cache, renderFn } = makeCache();

    expect(cache.render('', 'msg-1')).toBe('');
    expect(renderFn).not.toHaveBeenCalled();
  });
});
