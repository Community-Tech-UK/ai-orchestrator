import type { OutputMessage } from '../../shared/types/instance.types';
import { isVisibleOutputMessage } from '../../shared/types/tool-outcome';
import { redactSecrets } from '../security/secret-detector';

export const SESSION_READ_PAGE_CHARACTERS = 24_000;
const ITEM_CHARACTERS = 4000;
export interface TranscriptReadOptions {
  view?: 'messages' | 'activity';
  from?: 'end' | 'before-last-compaction';
  before?: number;
  limit?: number;
}
export interface TranscriptItem {
  seq: number;
  role: OutputMessage['type'];
  source: 'user' | 'assistant' | 'harness' | 'other-session' | 'tool';
  text: string;
  at: number;
  truncated: boolean;
}
export function isTranscriptReset(message: OutputMessage): boolean {
  return message.metadata?.['isCompactionBoundary'] === true
    || message.metadata?.['kind'] === 'session-boundary'
    || message.metadata?.['threadCompacted'] === true;
}

/** Seq is the position in the complete transcript, including filtered rows. */
export function projectSessionTranscript(messages: readonly OutputMessage[], options: TranscriptReadOptions) {
  const compactions = messages.flatMap((message, seq) => isTranscriptReset(message) ? [seq] : []);
  const end = options.before ?? (options.from === 'before-last-compaction' ? compactions.at(-1) : undefined) ?? messages.length;
  const all = messages.flatMap((message, seq): TranscriptItem[] => {
    if (!isVisibleOutputMessage(message)) return [];
    const harness = !!message.metadata?.internalInput;
    const relayed = !!message.metadata?.crossSessionMessage;
    if (options.view !== 'activity' && message.type !== 'user' && message.type !== 'assistant' && !harness && !relayed) return [];
    let raw = message.content;
    let smallCap = ITEM_CHARACTERS;
    if (message.type === 'tool_use') {
      const input = message.metadata?.['input'];
      // Continuity restores the canonical name as `toolName`; live adapters
      // carry `name`. Both must project the named-tool activity line.
      const toolName = String(message.metadata?.['toolName'] ?? message.metadata?.['name'] ?? 'Tool');
      raw = `${toolName}: ${input === undefined ? message.content : JSON.stringify(input)}`;
      smallCap = Math.min(ITEM_CHARACTERS, 200 + toolName.length + 2);
    } else if (message.type === 'tool_result') smallCap = 300;
    const safe = redactSecrets(raw);
    return [{ seq, role: message.type,
      source: relayed ? 'other-session' : harness || message.type === 'system' || message.type === 'error' ? 'harness' : message.type === 'user' ? 'user' : message.type === 'assistant' ? 'assistant' : 'tool',
      text: safe.slice(0, smallCap), at: message.timestamp, truncated: safe.length > smallCap }];
  });
  const eligible = all.filter((item) => item.seq < end).reverse();
  const items: TranscriptItem[] = [];
  let characters = 0;
  let truncated = false;
  for (const item of eligible.slice(0, Math.min(50, Math.max(1, options.limit ?? 20)))) {
    if (characters + item.text.length > SESSION_READ_PAGE_CHARACTERS) { truncated = true; break; }
    items.push(item);
    characters += item.text.length;
    truncated ||= item.truncated;
  }
  const oldest = items.at(-1)?.seq;
  return { totalItems: all.length, items, olderCursor: oldest !== undefined && eligible.some((item) => item.seq < oldest) ? oldest : null, compactions, truncated };
}
