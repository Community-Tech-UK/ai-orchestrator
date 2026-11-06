import { stripLeadingHarnessContext } from '../orchestration/harness-guidance';

const INDEXED_CONTEXT_START = '[Indexed Codebase Context]';
const INDEXED_CONTEXT_END = '[End Indexed Codebase Context]';

const LEADING_INDEXED_CONTEXT_PATTERN = new RegExp(
  `^\\s*${escapeRegExp(INDEXED_CONTEXT_START)}[\\s\\S]*?${escapeRegExp(INDEXED_CONTEXT_END)}\\s*`,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove app-injected context from a native Claude user turn while preserving
 * the text the user actually authored. Harness puts these in front of the typed
 * text on a later turn, in this order: memory, indexed codebase and retrieved
 * context, the active /goal, then the scheduling/consensus guidance. All of it
 * goes, because the chat only ever showed the typed text: the retained history
 * (and archive repair, which compares it with this text) holds nothing else.
 * Each block is matched by the exact shape its builder emits, in that order
 * (`stripLeadingHarnessContext`), so malformed or non-leading markers, blocks in
 * another order, and text that merely looks like a block or mentions a guidance
 * heading are left untouched and genuine user content is never discarded
 * speculatively.
 */
export function extractAuthoredUserMessage(content: string): string {
  return stripLeadingHarnessContext(content).trim();
}

export function hasIndexedCodebaseContextPreamble(content: string): boolean {
  return LEADING_INDEXED_CONTEXT_PATTERN.test(content);
}
