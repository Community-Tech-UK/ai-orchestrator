/**
 * Reads a Claude Code transcript (JSONL) for the recall check: how big the context
 * was at each point, where a clean cut near a target size lies, and a plain-text
 * excerpt of the conversation for writing questions.
 *
 * Everything here is in memory and pure. Nothing is logged or returned except the
 * text the caller asked for; callers must not print excerpts.
 */

export interface ContextPoint {
  messageId: string;
  /** Index of the last transcript line belonging to this assistant message. */
  lineIndex: number;
  /** Input plus both cache counts: what the model read for this request. */
  contextTokens: number;
  /** The message finished the turn (not a pause for a tool call). */
  endTurn: boolean;
}

import { createHash } from 'crypto';

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

function parse(line: string): Json | null {
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** One point per main-thread assistant message, in transcript order. */
export function contextPoints(lines: readonly string[]): ContextPoint[] {
  const byId = new Map<string, ContextPoint>();
  lines.forEach((line, lineIndex) => {
    const record = parse(line);
    if (!record || record['type'] !== 'assistant' || record['isSidechain'] === true) return;
    const message = record['message'];
    if (!isRecord(message) || typeof message['id'] !== 'string') return;
    const usage = message['usage'];
    if (!isRecord(usage)) return;
    const contextTokens = num(usage['input_tokens']) + num(usage['cache_read_input_tokens']) + num(usage['cache_creation_input_tokens']);
    const previous = byId.get(message['id']);
    byId.set(message['id'], {
      messageId: message['id'],
      lineIndex,
      contextTokens: Math.max(contextTokens, previous?.contextTokens ?? 0),
      endTurn: previous?.endTurn === true || message['stop_reason'] === 'end_turn',
    });
  });
  return [...byId.values()].sort((a, b) => a.lineIndex - b.lineIndex);
}

export interface TranscriptCut {
  /** Keep lines 0..cutLine. */
  cutLine: number;
  contextTokens: number;
  humanPrompts: number;
  /** Compactions already inside the kept part; such a chat is not a clean 300K sample. */
  priorBoundaries: number;
}

function isTypedPrompt(record: Json): boolean {
  if (record['type'] !== 'user' || record['isSidechain'] === true || record['isMeta'] === true || record['isCompactSummary'] === true) return false;
  const message = record['message'];
  if (!isRecord(message)) return false;
  const content = message['content'];
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some(block => isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim().length > 0);
}

/** Typed (human) prompts in lines 0..upTo, excluding tool results, meta and summary records. */
export function humanPromptCount(lines: readonly string[], upTo: number): number {
  let count = 0;
  for (let index = 0; index <= upTo && index < lines.length; index++) {
    const record = parse(lines[index]);
    if (record && isTypedPrompt(record)) count++;
  }
  return count;
}

const isBoundary = (record: Json | null): boolean => !!record && record['type'] === 'system' && record['subtype'] === 'compact_boundary';

/**
 * The last finished answer whose context is at or below `target` and within
 * `tolerance` of it, or null when the transcript has no clean cut there.
 */
export function analyseTranscript(lines: readonly string[], target: number, tolerance: number): TranscriptCut | null {
  const floor = target * (1 - tolerance);
  const candidates = contextPoints(lines).filter(point => point.endTurn && point.contextTokens <= target && point.contextTokens >= floor);
  if (candidates.length === 0) return null;
  const best = candidates.reduce((chosen, point) => (point.contextTokens >= chosen.contextTokens ? point : chosen));
  let priorBoundaries = 0;
  for (let index = 0; index <= best.lineIndex; index++) if (isBoundary(parse(lines[index]))) priorBoundaries++;
  return { cutLine: best.lineIndex, contextTokens: best.contextTokens, humanPrompts: humanPromptCount(lines, best.lineIndex), priorBoundaries };
}

/** The line of the first point whose context reaches `tokens` (the last point if none does). */
export function lineAtContext(points: readonly ContextPoint[], tokens: number): number {
  const hit = points.find(point => point.contextTokens >= tokens) ?? points.at(-1);
  return hit?.lineIndex ?? 0;
}

export interface ConversationSegment {
  role: 'user' | 'assistant' | 'tool-use' | 'tool-result';
  text: string;
  lineIndex: number;
}

const TOOL_ARGUMENT_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt'];
const TOOL_RESULT_CHARS = 400;
const TOOL_ARGUMENT_CHARS = 160;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function toolSummary(block: Json): string {
  const input = isRecord(block['input']) ? block['input'] : {};
  const key = TOOL_ARGUMENT_KEYS.find(name => typeof input[name] === 'string');
  return `${String(block['name'] ?? 'tool')}(${key ? clip(String(input[key]), TOOL_ARGUMENT_CHARS) : ''})`;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '')).join(' ');
}

/**
 * What was said, in order: typed prompts, the assistant's written answers, one line
 * per tool call and a short head of each tool result. Reasoning is left out.
 */
export function conversationSegments(lines: readonly string[], upTo: number): ConversationSegment[] {
  const segments: ConversationSegment[] = [];
  for (let lineIndex = 0; lineIndex <= upTo && lineIndex < lines.length; lineIndex++) {
    const record = parse(lines[lineIndex]);
    if (!record || record['isSidechain'] === true || record['isMeta'] === true || record['isCompactSummary'] === true) continue;
    const message = record['message'];
    if (!isRecord(message)) continue;
    const content = message['content'];
    if (record['type'] === 'user') {
      if (typeof content === 'string') { segments.push({ role: 'user', text: content.trim(), lineIndex }); continue; }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block['type'] === 'text' && typeof block['text'] === 'string') segments.push({ role: 'user', text: block['text'].trim(), lineIndex });
        if (block['type'] === 'tool_result') {
          const text = clip(resultText(block['content']), TOOL_RESULT_CHARS);
          if (text) segments.push({ role: 'tool-result', text, lineIndex });
        }
      }
    } else if (record['type'] === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) segments.push({ role: 'assistant', text: block['text'].trim(), lineIndex });
        if (block['type'] === 'tool_use') segments.push({ role: 'tool-use', text: toolSummary(block), lineIndex });
      }
    }
  }
  return segments.filter(segment => segment.text.length > 0);
}

const LABEL: Record<ConversationSegment['role'], string> = { user: 'USER', assistant: 'ASSISTANT', 'tool-use': 'TOOL', 'tool-result': 'RESULT' };

/** Plain text of the segments, cut off cleanly at `maxChars`. */
export function renderExcerpt(segments: readonly ConversationSegment[], maxChars: number): string {
  let out = '';
  for (const segment of segments) {
    const piece = `${LABEL[segment.role]}: ${segment.text}\n`;
    if (out.length + piece.length > maxChars) {
      const room = maxChars - out.length;
      if (out.length === 0 && room > 0) out = piece.slice(0, room);
      break;
    }
    out += piece;
  }
  return out;
}

/**
 * Identifies the conversation, not the file: the API message id at the cut is the same in a copy or a
 * resumed fork, whereas the session id differs. Short hash, so it reveals nothing about the content.
 */
export function conversationKeyAt(lines: readonly string[], lineIndex: number): string {
  const record = parse(lines[lineIndex] ?? '');
  const message = record && isRecord(record['message']) ? record['message'] : null;
  const id = message && typeof message['id'] === 'string' ? message['id'] : (lines[lineIndex] ?? '');
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

/**
 * The cost the CLI had already recorded for this session by line `upTo` (its last `cost-state` record), or 0.
 * A resumed session continues from this total, so every reply's `total_cost_usd` includes it.
 */
export function carriedCostUsd(lines: readonly string[], upTo: number): number {
  let carried = 0;
  for (let index = 0; index <= upTo && index < lines.length; index++) {
    if (!lines[index].includes('"cost-state"')) continue;
    const record = parse(lines[index]);
    const total = record?.['type'] === 'cost-state' ? record['totalCostUSD'] : undefined;
    if (typeof total === 'number' && Number.isFinite(total) && total >= 0) carried = total;
  }
  return carried;
}
