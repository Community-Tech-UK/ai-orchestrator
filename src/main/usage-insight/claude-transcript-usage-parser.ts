/**
 * Reads one line of a Claude Code transcript (`~/.claude/projects/.../*.jsonl`)
 * and keeps only what "Where your usage went" needs: the token counts of each
 * request, how big each tool result was, and where a chat was compacted.
 *
 * Nothing about what was said is returned. Message text, file paths and tool
 * arguments never leave this function.
 *
 * One request is written as several lines (one per content block) that share the
 * same message id and request id, so the caller merges them on `key`.
 */

import { DEFAULT_CHARS_PER_TOKEN } from '../../shared/utils/token-estimate';
import { BIG_TOOL_RESULT_TOKENS } from '../../shared/usage-insight/usage-cause-rules';

/** Lines longer than this are never decoded as JSON; only their size is used. */
export const MAX_PARSE_LINE_CHARS = 16 * 1024 * 1024;

export interface TranscriptRequestEvent {
  kind: 'request';
  /** `${message id}:${request id}`; null when the line cannot be matched to a response. */
  key: string | null;
  sessionId: string | null;
  at: number;
  model: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  sidechain: boolean;
  agentId: string | null;
}

export interface TranscriptToolResultsEvent {
  kind: 'tool-results';
  sidechain: boolean;
  agentId: string | null;
  /** Tokens in the results that were over the size limit. 0 when none were. */
  bigTokens: number;
}

export type TranscriptEvent =
  | TranscriptRequestEvent
  | TranscriptToolResultsEvent
  | { kind: 'compaction' }
  | { kind: 'invalid' }
  | { kind: 'other' };

const OTHER: TranscriptEvent = { kind: 'other' };
const COMPACTION: TranscriptEvent = { kind: 'compaction' };
const INVALID: TranscriptEvent = { kind: 'invalid' };

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A line too big to decode safely. One that holds a tool result is, by size
 * alone, a result far over the limit; anything else is ignored.
 */
export function oversizedLineEvent(length: number, hasToolResult: boolean): TranscriptEvent {
  return hasToolResult
    ? { kind: 'tool-results', sidechain: false, agentId: null, bigTokens: Math.ceil(length / DEFAULT_CHARS_PER_TOKEN) }
    : OTHER;
}

export function parseTranscriptLine(line: string): TranscriptEvent {
  if (line.length === 0) return OTHER;
  const hasUsage = line.includes('"usage"');
  const hasToolResult = line.includes('"tool_result"');
  const hasCompaction = line.includes('compact_boundary')
    || line.includes('"compactMetadata"')
    || line.includes('"isCompactSummary"');
  if (!hasUsage && !hasToolResult && !hasCompaction) return OTHER;

  if (line.length > MAX_PARSE_LINE_CHARS) return oversizedLineEvent(line.length, hasToolResult);

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return INVALID;
  }
  const entry = record(parsed);
  if (!entry) return OTHER;

  if (entry['type'] === 'system') {
    return entry['subtype'] === 'compact_boundary' || entry['compactMetadata'] !== undefined ? COMPACTION : OTHER;
  }
  if (entry['type'] === 'assistant') return parseAssistant(entry);
  if (entry['type'] === 'user') {
    if (entry['isCompactSummary'] === true) return COMPACTION;
    return parseUser(entry);
  }
  return OTHER;
}

function parseAssistant(entry: Json): TranscriptEvent {
  if (entry['isApiErrorMessage'] === true) return OTHER;
  const message = record(entry['message']);
  const usage = record(message?.['usage']);
  if (!message || !usage) return OTHER;
  const model = text(message['model']);
  if (!model || model.startsWith('<')) return OTHER;
  const at = Date.parse(String(entry['timestamp'] ?? ''));
  if (!Number.isFinite(at)) return OTHER;

  const split = record(usage['cache_creation']);
  const cacheWrite = usage['cache_creation_input_tokens'] !== undefined
    ? count(usage['cache_creation_input_tokens'])
    : count(split?.['ephemeral_5m_input_tokens']) + count(split?.['ephemeral_1h_input_tokens']);
  const input = count(usage['input_tokens']);
  const cacheRead = count(usage['cache_read_input_tokens']);
  const output = count(usage['output_tokens']);
  if (input + cacheWrite + cacheRead + output === 0) return OTHER;

  const messageId = text(message['id']);
  const requestId = text(entry['requestId']);
  return {
    kind: 'request',
    key: messageId ? `${messageId}:${requestId ?? ''}` : null,
    sessionId: text(entry['sessionId']),
    at,
    model,
    input,
    cacheWrite,
    cacheRead,
    output,
    sidechain: entry['isSidechain'] === true,
    agentId: text(entry['agentId']),
  };
}

function parseUser(entry: Json): TranscriptEvent {
  const message = record(entry['message']);
  const content = message?.['content'];
  if (!Array.isArray(content)) return OTHER;
  let bigTokens = 0;
  let seen = false;
  for (const block of content) {
    const item = record(block);
    if (!item || item['type'] !== 'tool_result') continue;
    seen = true;
    const tokens = Math.ceil(resultChars(item['content']) / DEFAULT_CHARS_PER_TOKEN);
    if (tokens > BIG_TOOL_RESULT_TOKENS) bigTokens += tokens;
  }
  return seen
    ? { kind: 'tool-results', sidechain: entry['isSidechain'] === true, agentId: text(entry['agentId']), bigTokens }
    : OTHER;
}

/** Characters of text in a tool result. Images and other blocks add nothing. */
function resultChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    const item = record(block);
    if (item && item['type'] === 'text' && typeof item['text'] === 'string') chars += item['text'].length;
  }
  return chars;
}
