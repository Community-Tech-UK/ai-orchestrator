/**
 * Pure memory-tag helpers for the unified memory controller.
 *
 * Split out of unified-controller.ts. Memory entries are tagged with
 * `[instance:…]` / `[session:…]` prefixes so retrieval can scope results; these
 * functions build filter tags, apply them, and strip tags for display. All are
 * stateless.
 */
import type { RetrievalOptions } from '../../shared/types/unified-memory.types';
import type { MemoryEntry } from '../../shared/types/memory-r1.types';

export function ensureSessionTag(input: string, sessionId: string): string {
  if (/^\s*\[(?:instance|session):/i.test(input)) {
    return input;
  }

  return `[session:${sessionId}] ${input}`;
}

export function getFilterTags(options?: RetrievalOptions): string[] {
  const tags: string[] = [];

  if (options?.instanceId) {
    tags.push(`[instance:${options.instanceId}]`);
  }

  if (options?.sessionId) {
    tags.push(`[session:${options.sessionId}]`);
  }

  return tags;
}

export function filterShortTermBuffer(buffer: string[], tags: string[]): string[] {
  if (tags.length === 0) return buffer;
  return buffer.filter((content) => matchesFilterTags(content, tags));
}

export function filterEntriesByTags(
  entries: MemoryEntry[],
  tags: string[],
  options?: RetrievalOptions
): MemoryEntry[] {
  if (tags.length === 0) return entries;

  return entries.filter((entry) => {
    if (options?.sessionId && entry.sourceSessionId === options.sessionId) {
      return true;
    }
    return matchesFilterTags(entry.content, tags);
  });
}

export function matchesFilterTags(content: string, tags: string[]): boolean {
  return tags.every((tag) => content.includes(tag));
}

export function stripMemoryTags(content: string): string {
  return content
    .replace(/^\s*(\[(?:instance|session):[^\]]+\]\s*)+/i, '')
    .trim();
}
