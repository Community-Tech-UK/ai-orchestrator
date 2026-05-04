import { readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import type {
  ConversationMessageUpsertInput,
  NativeConversationSnapshot,
} from '../../../shared/types/conversation-ledger.types';

interface ParseOptions {
  sourcePath?: string;
  sourceMtime?: number;
  workspacePath?: string;
}

interface ParsedLine {
  lineNumber: number;
  raw: string;
  entry: Record<string, unknown>;
}

export function parseCodexRolloutFile(filePath: string): NativeConversationSnapshot {
  const content = readFileSync(filePath, 'utf8');
  const sourceMtime = statSync(filePath).mtimeMs;
  return parseCodexRolloutJsonl(content, { sourcePath: filePath, sourceMtime });
}

export function parseCodexRolloutJsonl(
  content: string,
  options: ParseOptions = {}
): NativeConversationSnapshot {
  const warnings: string[] = [];
  const rawRefs: string[] = [];
  const messages: ConversationMessageUpsertInput[] = [];
  const seenAssistant = new Map<string, number>();
  const tokenTotals = { input: 0, output: 0, cached: 0, reasoning: 0 };
  let threadId: string | null = null;
  let workspacePath: string | null = options.workspacePath ?? null;
  let title: string | null = null;
  let model: string | null = null;
  let nativeSourceKind: string | null = null;
  let createdAt: number | null = null;
  let updatedAt = 0;
  let currentTurnId: string | null = null;
  let sequence = 0;

  for (const parsed of parseLines(content, warnings)) {
    const { entry, lineNumber, raw } = parsed;
    rawRefs.push(rawRef(options.sourcePath, lineNumber));
    const type = stringValue(entry['type']);
    const payload = objectValue(entry['payload']) ?? entry;
    const timestamp = timestampMs(entry['timestamp']) ?? timestampMs(payload['timestamp']);
    if (timestamp) {
      createdAt ??= timestamp;
      updatedAt = Math.max(updatedAt, timestamp);
    }

    if (type === 'session_meta' || entry['session_meta']) {
      threadId ??= stringValue(payload['id']) ?? stringValue(entry['threadId']);
      workspacePath ??= stringValue(payload['cwd']) ?? stringValue(entry['cwd']);
      model ??= stringValue(payload['model']) ?? stringValue(entry['model']);
      nativeSourceKind ??= normalizeSourceKind(payload['source'] ?? entry['source']);
      continue;
    }

    if (type === 'turn_context') {
      currentTurnId = stringValue(payload['turn_id']) ?? stringValue(payload['turnId']) ?? currentTurnId;
      workspacePath ??= stringValue(payload['cwd']);
      model = stringValue(payload['model']) ?? model;
      continue;
    }

    threadId ??= stringValue(payload['thread_id']) ?? stringValue(entry['threadId']);

    if (type === 'event_msg') {
      const hasNestedPayload = objectValue(entry['payload']) !== null;
      const eventType = hasNestedPayload
        ? stringValue(payload['type'])
        : stringValue(entry['subtype']);
      if (eventType === 'thread_name_updated') {
        title = stringValue(payload['thread_name']) ?? stringValue(payload['name']) ?? title;
        threadId ??= stringValue(payload['thread_id']);
        continue;
      }
      if (eventType === 'token_count') {
        const usage = objectValue(payload['info'])?.['total_token_usage'] ?? payload;
        tokenTotals.input += numberValue((usage as Record<string, unknown>)['input_tokens'])
          ?? numberValue((usage as Record<string, unknown>)['inputTokens'])
          ?? 0;
        tokenTotals.output += numberValue((usage as Record<string, unknown>)['output_tokens'])
          ?? numberValue((usage as Record<string, unknown>)['outputTokens'])
          ?? 0;
        tokenTotals.cached += numberValue((usage as Record<string, unknown>)['cached_tokens'])
          ?? numberValue((usage as Record<string, unknown>)['cachedTokens'])
          ?? 0;
        tokenTotals.reasoning += numberValue((usage as Record<string, unknown>)['reasoning_tokens'])
          ?? numberValue((usage as Record<string, unknown>)['reasoningTokens'])
          ?? 0;
        continue;
      }

      const message = eventMessageToLedgerMessage(
        eventType,
        payload,
        entry,
        raw,
        currentTurnId,
        timestamp ?? updatedAt,
        sequence + 1,
        options.sourcePath,
        lineNumber,
      );
      if (message) {
        if (message.role === 'assistant') {
          seenAssistant.set(`${message.nativeTurnId ?? ''}:${message.content}`, sequence + 1);
        }
        sequence += 1;
        messages.push(message);
      }
      continue;
    }

    if (type === 'response_item') {
      const itemType = stringValue(payload['type']);
      const message = responseItemToLedgerMessage(
        itemType,
        payload,
        entry,
        raw,
        currentTurnId,
        timestamp ?? updatedAt,
        sequence + 1,
        options.sourcePath,
        lineNumber,
      );
      if (!message) continue;
      if (message.role === 'assistant') {
        const dedupeKey = `${message.nativeTurnId ?? ''}:${message.content}`;
        if (seenAssistant.has(dedupeKey)) {
          continue;
        }
        seenAssistant.set(dedupeKey, sequence + 1);
      }
      sequence += 1;
      messages.push(message);
      continue;
    }

    if (type === 'session_meta') continue;

    if (stringValue(entry['subtype']) === 'token_count') {
      tokenTotals.input += numberValue(entry['input_tokens']) ?? numberValue(entry['inputTokens']) ?? 0;
      tokenTotals.output += numberValue(entry['output_tokens']) ?? numberValue(entry['outputTokens']) ?? 0;
      tokenTotals.cached += numberValue(entry['cached_tokens']) ?? numberValue(entry['cachedTokens']) ?? 0;
      tokenTotals.reasoning += numberValue(entry['reasoning_tokens']) ?? numberValue(entry['reasoningTokens']) ?? 0;
    }
  }

  for (const message of messages) {
    if (message.role === 'assistant') {
      const dedupeKey = `${message.nativeTurnId ?? ''}:${message.content}`;
      const firstSequence = seenAssistant.get(dedupeKey);
      if (firstSequence === undefined) {
        seenAssistant.set(dedupeKey, message.sequence);
      }
    }
  }

  const resolvedThreadId = threadId ?? deterministicId('codex-thread', content);
  if (!threadId) warnings.push('Codex rollout did not include a native thread id; generated a deterministic fallback.');
  if (!workspacePath) warnings.push('Codex rollout did not include a workspace path.');

  return {
    thread: {
      provider: 'codex',
      nativeThreadId: resolvedThreadId,
      nativeSessionId: resolvedThreadId,
      nativeSourceKind: nativeSourceKind ?? 'unknown',
      sourcePath: options.sourcePath ?? null,
      workspacePath,
      title,
      createdAt: createdAt ?? updatedAt,
      updatedAt: updatedAt || createdAt || Date.now(),
      writable: true,
      nativeVisibilityMode: 'filesystem-visible',
      metadata: { model },
    },
    messages: messages.map(message => ({
      ...message,
      id: message.id ?? deterministicMessageId(resolvedThreadId, message),
    })),
    cursor: {
      threadId: '',
      provider: 'codex',
      cursorKind: 'codex-rollout-file',
      cursorValue: String(messages.length),
      sourcePath: options.sourcePath ?? null,
      sourceMtime: options.sourceMtime ?? null,
      lastSeenChecksum: checksum(content),
      updatedAt: Date.now(),
    },
    tokenTotals,
    warnings,
    rawRefs,
  };
}

function parseLines(content: string, warnings: string[]): ParsedLine[] {
  const parsed: ParsedLine[] = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as unknown;
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        parsed.push({ lineNumber: index + 1, raw: line, entry: entry as Record<string, unknown> });
      }
    } catch {
      warnings.push(`Malformed JSONL line skipped: ${index + 1}`);
    }
  }
  return parsed;
}

function eventMessageToLedgerMessage(
  eventType: string | null,
  payload: Record<string, unknown>,
  entry: Record<string, unknown>,
  raw: string,
  currentTurnId: string | null,
  createdAt: number,
  sequence: number,
  sourcePath: string | undefined,
  lineNumber: number
): ConversationMessageUpsertInput | null {
  if (eventType === 'user_message') {
    const content = stringValue(payload['message']) ?? stringValue(entry['message']);
    return content ? makeMessage('user', content, payload, raw, currentTurnId, createdAt, sequence, sourcePath, lineNumber) : null;
  }
  if (eventType === 'agent_message') {
    const content = stringValue(payload['message']) ?? stringValue(entry['message']);
    const phase = stringValue(payload['phase']) ?? null;
    return content ? makeMessage('assistant', content, payload, raw, currentTurnId, createdAt, sequence, sourcePath, lineNumber, phase) : null;
  }
  if (eventType === 'exec_command_end') {
    const output = stringValue(payload['aggregated_output']) ?? '';
    const exitCode = numberValue(payload['exit_code']);
    return makeMessage(
      'tool',
      `Command exited${exitCode === null ? '' : ` with ${exitCode}`}${output ? `\n${output}` : ''}`,
      payload,
      raw,
      currentTurnId,
      createdAt,
      sequence,
      sourcePath,
      lineNumber,
    );
  }
  return null;
}

function responseItemToLedgerMessage(
  itemType: string | null,
  payload: Record<string, unknown>,
  entry: Record<string, unknown>,
  raw: string,
  currentTurnId: string | null,
  createdAt: number,
  sequence: number,
  sourcePath: string | undefined,
  lineNumber: number
): ConversationMessageUpsertInput | null {
  if (itemType === 'message') {
    const content = extractResponseContent(payload['content']) ?? stringValue(payload['text']);
    const role = stringValue(payload['role']) === 'user' ? 'user' : 'assistant';
    return content ? makeMessage(role, content, entry, raw, currentTurnId, createdAt, sequence, sourcePath, lineNumber, stringValue(payload['phase'])) : null;
  }
  if (itemType === 'reasoning') {
    const content = extractResponseContent(payload['summary']) ?? extractResponseContent(payload['content']);
    return content ? makeMessage('event', content, entry, raw, currentTurnId, createdAt, sequence, sourcePath, lineNumber, 'reasoning') : null;
  }
  if (itemType === 'function_call') {
    const name = stringValue(payload['name']) ?? 'function_call';
    const args = stringValue(payload['arguments']) ?? JSON.stringify(payload['arguments'] ?? {});
    return makeMessage('tool', `${name} ${args}`, entry, raw, currentTurnId, createdAt, sequence, sourcePath, lineNumber);
  }
  if (itemType === 'function_call_output') {
    const output = stringValue(payload['output']) ?? extractResponseContent(payload['content']);
    return output ? makeMessage('tool', output, entry, raw, currentTurnId, createdAt, sequence, sourcePath, lineNumber) : null;
  }
  return null;
}

function makeMessage(
  role: ConversationMessageUpsertInput['role'],
  content: string,
  rawJson: Record<string, unknown>,
  raw: string,
  nativeTurnId: string | null,
  createdAt: number,
  sequence: number,
  sourcePath: string | undefined,
  lineNumber: number,
  phase: string | null = null
): ConversationMessageUpsertInput {
  const sourceChecksum = checksum(raw);
  return {
    nativeMessageId: stringValue(rawJson['id']) ?? null,
    nativeTurnId,
    role,
    phase,
    content,
    createdAt,
    tokenInput: null,
    tokenOutput: null,
    rawRef: rawRef(sourcePath, lineNumber),
    rawJson,
    sourceChecksum,
    sequence,
  };
}

function deterministicMessageId(threadId: string, message: ConversationMessageUpsertInput): string {
  return deterministicId('codex-message', `${threadId}:${message.sequence}:${message.sourceChecksum ?? message.content}`);
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}_${checksum(value).slice(0, 24)}`;
}

function checksum(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rawRef(sourcePath: string | undefined, lineNumber: number): string {
  return sourcePath ? `${sourcePath}:${lineNumber}` : `jsonl:${lineNumber}`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractResponseContent(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const record = objectValue(item);
    const text = record ? stringValue(record['text']) ?? stringValue(record['content']) : null;
    if (text) parts.push(text);
  }
  return parts.length ? parts.join('\n') : null;
}

function normalizeSourceKind(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if ('subAgent' in value) return 'subAgent';
    if ('custom' in value && typeof (value as { custom?: unknown }).custom === 'string') {
      return (value as { custom: string }).custom;
    }
  }
  return null;
}
