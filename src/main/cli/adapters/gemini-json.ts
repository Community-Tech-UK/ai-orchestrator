import { parseNdjsonLine, parseStreamingJson } from '../json-parse';

/**
 * A single NDJSON event from the Gemini CLI stream.
 *
 * This is a parsing boundary for external process output: the event shapes
 * vary across gemini-cli versions, so no field can be trusted to have a
 * particular type. Every field is therefore `unknown`, and consumers must go
 * through the typed accessors below (or narrow explicitly with `typeof` /
 * `in` guards) instead of assuming a shape.
 */
export type GeminiStreamEvent = Readonly<Record<string, unknown>>;

/** Token totals extracted from a Gemini usage-bearing event. */
export interface GeminiUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

interface GeminiJsonLogger {
  warn(message: string, metadata: Record<string, unknown>): void;
}

export function parseGeminiNdjsonEvent(line: string): GeminiStreamEvent | null {
  const result = parseNdjsonLine<unknown>(line);
  return result.ok && isGeminiEvent(result.value) ? result.value : null;
}

export function parseGeminiStreamingEvent(line: string): GeminiStreamEvent | null {
  const strict = parseGeminiNdjsonEvent(line);
  if (strict) return strict;

  const partial = parseStreamingJson<unknown>(line);
  if (!partial.ok || !isGeminiEvent(partial.value)) return null;
  if (partial.partial && geminiAssistantText(partial.value) === null) return null;
  return partial.value;
}

export function logGeminiParseFailure(logger: GeminiJsonLogger, line: string): void {
  if (line.trim().startsWith('{')) {
    logger.warn('Failed to parse Gemini stream-json line', { linePreview: line.slice(0, 200) });
  }
}

function isGeminiEvent(value: unknown): value is GeminiStreamEvent {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The event's `type` field, when it is a non-empty string. */
export function geminiEventType(event: GeminiStreamEvent): string | null {
  return nonEmptyString(event['type']);
}

/**
 * Assistant-visible text carried by a content event, or `null` when the event
 * is not a content event. Recognized shapes:
 *   {"type":"message","role":"assistant","content":"..."}
 *   {"type":"text","text":"..."}
 */
export function geminiAssistantText(event: GeminiStreamEvent): string | null {
  const type = geminiEventType(event);
  if (type === 'message' && event['role'] === 'assistant') {
    return nonEmptyString(event['content']);
  }
  if (type === 'text') {
    return nonEmptyString(event['text']);
  }
  return null;
}

/**
 * Best-effort tool name from a tool-scoped event. The exact field varies
 * across gemini-cli versions (`tool`, `name`, `toolName`, `data.toolName`).
 */
export function geminiToolName(event: GeminiStreamEvent): string {
  const direct =
    nonEmptyString(event['tool']) ?? nonEmptyString(event['name']) ?? nonEmptyString(event['toolName']);
  if (direct) return direct;
  const data = event['data'];
  if (isRecord(data)) {
    const nested = nonEmptyString(data['toolName']);
    if (nested) return nested;
  }
  return 'unknown';
}

/**
 * Human-readable error text from an error-bearing event. Handles string
 * errors, `{message}` error objects, a top-level `message` field, and falls
 * back to serializing whatever payload is present.
 */
export function geminiErrorText(event: GeminiStreamEvent): string {
  const error = event['error'];
  if (typeof error === 'string' && error.length > 0) return error;
  if (isRecord(error)) {
    const message = nonEmptyString(error['message']);
    if (message) return message;
  }
  const topLevel = nonEmptyString(event['message']);
  if (topLevel) return topLevel;
  return safeStringify(error ?? event);
}

/** Result text from a `tool_result`-style event ("ok" when absent). */
export function geminiResultText(event: GeminiStreamEvent): string {
  const result = event['result'];
  if (typeof result === 'string') return result;
  if (result !== undefined) return safeStringify(result);
  return 'ok';
}

/**
 * The API error message from a terminal error result event, or `null`.
 * Format: {"type":"result","status":"error","error":{"message":"..."}}
 */
export function geminiApiErrorMessage(event: GeminiStreamEvent): string | null {
  if (geminiEventType(event) !== 'result' || event['status'] !== 'error') return null;
  const error = event['error'];
  if (error === undefined || error === null) return null;
  if (typeof error === 'string' && error.length > 0) return error;
  if (isRecord(error)) {
    const message = nonEmptyString(error['message']);
    if (message) return message;
  }
  return safeStringify(error);
}

/**
 * Token usage totals from a usage-bearing event, or `null` when the event
 * carries no usable usage payload. Recognized formats:
 *   1. {"type":"result","stats":{"total_tokens":N,"input_tokens":N,"output_tokens":N}}
 *   2. {"type":"result","usageMetadata":{"promptTokenCount":N,"candidatesTokenCount":N,"totalTokenCount":N}}
 *   3. {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N}}
 *   4. Any event with a top-level "usage" object containing token fields
 */
export function geminiUsageTotals(event: GeminiStreamEvent): GeminiUsageTotals | null {
  const type = geminiEventType(event);

  if (type === 'result') {
    const stats = event['stats'];
    if (isRecord(stats)) {
      return {
        inputTokens: finiteNumber(stats['input_tokens']) || finiteNumber(stats['input']),
        outputTokens: finiteNumber(stats['output_tokens']),
        totalTokens: finiteNumber(stats['total_tokens']),
      };
    }
    const meta = event['usageMetadata'];
    if (isRecord(meta)) {
      const input = finiteNumber(meta['promptTokenCount']);
      const output = finiteNumber(meta['candidatesTokenCount']);
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: finiteNumber(meta['totalTokenCount']) || input + output,
      };
    }
  }

  const usage = event['usage'];
  if (isRecord(usage)) {
    if (type === 'turn.completed') {
      const input = finiteNumber(usage['input_tokens']);
      const output = finiteNumber(usage['output_tokens']);
      return { inputTokens: input, outputTokens: output, totalTokens: input + output };
    }
    const input = finiteNumber(usage['input_tokens']) || finiteNumber(usage['promptTokenCount']);
    const output = finiteNumber(usage['output_tokens']) || finiteNumber(usage['candidatesTokenCount']);
    const total = finiteNumber(usage['total_tokens']) || finiteNumber(usage['totalTokenCount']);
    if (input || output || total) {
      return { inputTokens: input, outputTokens: output, totalTokens: total || input + output };
    }
  }

  return null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
