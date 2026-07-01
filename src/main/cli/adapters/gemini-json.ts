import { parseNdjsonLine, parseStreamingJson } from '../json-parse';

type GeminiStreamEvent = Record<string, any> & {
  content?: any;
  data?: any;
  error?: any;
  message?: any;
  name?: any;
  result?: any;
  role?: any;
  stats?: any;
  status?: any;
  text?: any;
  tool?: any;
  toolName?: any;
  type?: any;
  usage?: any;
  usageMetadata?: any;
};

interface GeminiJsonLogger {
  warn(message: string, metadata: Record<string, unknown>): void;
}

export function parseGeminiNdjsonEvent(line: string): GeminiStreamEvent | null {
  const result = parseNdjsonLine<GeminiStreamEvent>(line);
  return result.ok && isGeminiEvent(result.value) ? result.value : null;
}

export function parseGeminiStreamingEvent(line: string): GeminiStreamEvent | null {
  const strict = parseGeminiNdjsonEvent(line);
  if (strict) return strict;

  const partial = parseStreamingJson<GeminiStreamEvent>(line);
  if (!partial.ok || !isGeminiEvent(partial.value)) return null;
  if (partial.partial && !hasUsefulPartialGeminiPayload(partial.value)) return null;
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

function hasUsefulPartialGeminiPayload(event: GeminiStreamEvent): boolean {
  return (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string' && event.content.length > 0)
    || (event.type === 'text' && typeof event.text === 'string' && event.text.length > 0);
}
