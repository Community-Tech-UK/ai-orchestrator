const INDEXED_CONTEXT_START = '[Indexed Codebase Context]';
const INDEXED_CONTEXT_END = '[End Indexed Codebase Context]';

const LEADING_INDEXED_CONTEXT_PATTERN = new RegExp(
  `^\\s*${escapeRegExp(INDEXED_CONTEXT_START)}[\\s\\S]*?${escapeRegExp(INDEXED_CONTEXT_END)}\\s*`,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove app-injected codebase context from a native Claude user turn while
 * preserving the text the user actually authored. Multiple leading context
 * blocks are handled defensively; malformed or non-leading markers are left
 * untouched so genuine user content is never discarded speculatively.
 */
export function extractAuthoredUserMessage(content: string): string {
  let authored = content;
  while (LEADING_INDEXED_CONTEXT_PATTERN.test(authored)) {
    authored = authored.replace(LEADING_INDEXED_CONTEXT_PATTERN, '');
  }
  return authored.trim();
}

export function hasIndexedCodebaseContextPreamble(content: string): boolean {
  return LEADING_INDEXED_CONTEXT_PATTERN.test(content);
}
