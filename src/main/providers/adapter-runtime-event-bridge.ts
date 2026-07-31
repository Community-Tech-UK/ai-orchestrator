import { createHash, randomUUID } from 'node:crypto';
import type { EventEmitter } from 'events';
import type { CliResponse, CliToolCall } from '../cli/adapters/base-cli-adapter';
import { toProviderOutputEvent } from './provider-output-event';
import type { ContextUsage, OutputMessage } from '../../shared/types/instance.types';
import type {
  ProviderQuotaDiagnostics,
  ProviderPromptWeightBreakdown,
  ProviderRateLimitDiagnostics,
  ProviderRuntimeEvent,
  ProviderToolResultObservedEvent,
  ProviderToolUseObservedEvent,
  ProviderUnknownEvent,
} from '@contracts/types/provider-runtime-events';
import { getLogger } from '../logging/logger';
import { normalizeUsage, type UsageLike } from '../../shared/util/usage-normalization';
import { toJsonSafeProviderEventPayload } from './provider-event-raw-payload';

const bridgeLogger = getLogger('AdapterRuntimeEventBridge');

/**
 * WS-B10: cap on the serialized size of a `ProviderUnknownEvent.payload`.
 * Oversized payloads are replaced with a `{ truncated: true, ... }` marker
 * (see `capUnknownEventPayload`) instead of forwarding an unbounded blob
 * through IPC and into the capture ledger.
 */
export const UNKNOWN_EVENT_PAYLOAD_MAX_BYTES = 4096;

/** Bound on the human-readable tool observation summaries (args/result). */
const TOOL_OBSERVATION_SUMMARY_MAX_CHARS = 200;

export type AdapterRuntimeEventSource = Pick<EventEmitter, 'on' | 'off'>;

type ProviderRuntimeEventKind = ProviderRuntimeEvent['kind'];
type ProviderRuntimeEventOfKind<K extends ProviderRuntimeEventKind> = Extract<ProviderRuntimeEvent, { kind: K }>;

interface NormalizedAdapterRuntimeEventBase<K extends ProviderRuntimeEventKind, TRawPayload> {
  kind: K;
  eventId: string;
  timestamp: number;
  event: ProviderRuntimeEventOfKind<K>;
  rawPayload: TRawPayload;
}

type NormalizedAdapterRuntimeRawPayload<K extends ProviderRuntimeEventKind> =
  K extends 'output' ? OutputMessage | string
    : K extends 'tool_use' | 'tool_result' ? CliToolCall
      : K extends 'status' ? string
        : K extends 'context' ? ContextUsage
          : K extends 'error' ? Error | string
            : K extends 'complete' ? CliResponse
              : K extends 'exit' ? { code: number | null; signal: string | null }
                : K extends 'spawned' ? number
                  // WS-B10: `unknown` is the only new kind that can flow through
                  // observeAdapterRuntimeEvents() today (output/context fail-closed
                  // routing); tool_use_observed/tool_result_observed are pure
                  // normalizers not yet wired into this live stream.
                  : K extends 'unknown' ? unknown
                    : never;

export type NormalizedAdapterRuntimeEvent =
  | NormalizedAdapterRuntimeEventBase<'output', OutputMessage | string>
  | NormalizedAdapterRuntimeEventBase<'tool_use', CliToolCall>
  | NormalizedAdapterRuntimeEventBase<'tool_result', CliToolCall>
  | NormalizedAdapterRuntimeEventBase<'status', string>
  | NormalizedAdapterRuntimeEventBase<'context', ContextUsage>
  | NormalizedAdapterRuntimeEventBase<'error', Error | string>
  | NormalizedAdapterRuntimeEventBase<'complete', CliResponse>
  | NormalizedAdapterRuntimeEventBase<'exit', { code: number | null; signal: string | null }>
  | NormalizedAdapterRuntimeEventBase<'spawned', number>
  | NormalizedAdapterRuntimeEventBase<'unknown', unknown>;

export type AdapterRuntimeEventName =
  | 'output'
  | 'tool_use'
  | 'tool_result'
  | 'status'
  | 'context'
  | 'error'
  | 'complete'
  | 'exit'
  | 'spawned';

export interface MappedAdapterRuntimeEvent {
  event: ProviderRuntimeEvent;
  rawPayload: unknown;
  timestamp?: number;
}

export interface AdapterToolResultCapturePayload {
  content: Uint8Array;
  mimeType: 'text/plain;charset=utf-8';
}

/** Own the exact UTF-8 bytes AIO received from an adapter tool-result event. */
export function getAdapterToolResultCapturePayload(
  toolCall: Pick<CliToolCall, 'result'>,
): AdapterToolResultCapturePayload | null {
  if (toolCall.result === undefined) return null;
  return {
    content: new TextEncoder().encode(toolCall.result),
    mimeType: 'text/plain;charset=utf-8',
  };
}

interface ProviderApiDiagnostics {
  requestId?: string;
  stopReason?: string;
  rateLimit?: ProviderRateLimitDiagnostics;
  quota?: ProviderQuotaDiagnostics;
}

export function observeAdapterRuntimeEvents(
  adapter: AdapterRuntimeEventSource,
  onEvent: (event: NormalizedAdapterRuntimeEvent) => void,
): () => void {
  const emit = (
    event: ProviderRuntimeEvent,
    rawPayload: unknown,
    timestamp = Date.now(),
  ): void => {
    const normalizedEvent = {
      kind: event.kind,
      eventId: randomUUID(),
      timestamp,
      event,
      rawPayload,
    } as NormalizedAdapterRuntimeEvent;

    onEvent(normalizedEvent);
  };

  const emitMapped = (name: AdapterRuntimeEventName, args: unknown[]): void => {
    const mapped = mapAdapterRuntimeEvent(name, args);
    if (mapped) emit(mapped.event, mapped.rawPayload, mapped.timestamp);
  };

  const onOutput = (message: OutputMessage | string): void => emitMapped('output', [message]);
  const onToolUse = (toolCall: CliToolCall): void => emitMapped('tool_use', [toolCall]);
  const onToolResult = (toolCall: CliToolCall): void => emitMapped('tool_result', [toolCall]);
  const onStatus = (status: string): void => emitMapped('status', [status]);
  const onContext = (usage: unknown): void => emitMapped('context', [usage]);
  const onError = (error: Error | string): void => emitMapped('error', [error]);
  const onComplete = (response: CliResponse): void => emitMapped('complete', [response]);
  const onExit = (code: number | null, signal: string | null): void => emitMapped('exit', [code, signal]);
  const onSpawned = (pid: number): void => emitMapped('spawned', [pid]);

  adapter.on('output', onOutput);
  adapter.on('tool_use', onToolUse);
  adapter.on('tool_result', onToolResult);
  adapter.on('status', onStatus);
  adapter.on('context', onContext);
  adapter.on('error', onError);
  adapter.on('complete', onComplete);
  adapter.on('exit', onExit);
  adapter.on('spawned', onSpawned);

  return () => {
    adapter.off('output', onOutput);
    adapter.off('tool_use', onToolUse);
    adapter.off('tool_result', onToolResult);
    adapter.off('status', onStatus);
    adapter.off('context', onContext);
    adapter.off('error', onError);
    adapter.off('complete', onComplete);
    adapter.off('exit', onExit);
    adapter.off('spawned', onSpawned);
  };
}

/** Pure adapter-event mapper used by the runtime bridge and fixture replay. */
export function mapAdapterRuntimeEvent(
  name: AdapterRuntimeEventName,
  args: readonly unknown[],
): MappedAdapterRuntimeEvent | null {
  switch (name) {
    case 'output': {
      const rawPayload = args[0] as OutputMessage | string;
      // An empty string is an intentional no-op (nothing to normalize into an
      // output event), not an unrecognized shape — keep dropping it silently.
      if (typeof rawPayload === 'string' && !rawPayload) {
        return null;
      }
      const normalized = normalizeOutputMessage(rawPayload);
      if (normalized) {
        return { event: toProviderOutputEvent(normalized), rawPayload, timestamp: normalized.timestamp };
      }
      // WS-B10: previously a silent drop (see the `[NORMALIZE_DROP]` warn
      // above in normalizeOutputMessage) — fail-closed into `unknown` instead.
      return { event: buildUnknownEvent('output', rawPayload), rawPayload };
    }
    case 'tool_use': {
      const rawPayload = args[0] as CliToolCall;
      return { event: { kind: 'tool_use', toolName: rawPayload.name, toolUseId: rawPayload.id, input: rawPayload.arguments }, rawPayload };
    }
    case 'tool_result': {
      const rawPayload = args[0] as CliToolCall;
      return { event: { kind: 'tool_result', toolName: rawPayload.name, toolUseId: rawPayload.id, success: true, output: rawPayload.result }, rawPayload };
    }
    case 'status': {
      const rawPayload = args[0] as string;
      return { event: { kind: 'status', status: rawPayload }, rawPayload };
    }
    case 'context': {
      const rawPayload = args[0];
      const normalized = normalizeContextUsage(rawPayload);
      if (!normalized) {
        // WS-B10: previously a silent drop with no log at all — fail-closed
        // into `unknown` instead.
        return { event: buildUnknownEvent('context', rawPayload), rawPayload };
      }
      return {
        event: {
          kind: 'context', used: normalized.used, total: normalized.total, percentage: normalized.percentage,
          ...(normalized.inputTokens !== undefined ? { inputTokens: normalized.inputTokens } : {}),
          ...(normalized.outputTokens !== undefined ? { outputTokens: normalized.outputTokens } : {}),
          ...(normalized.source !== undefined ? { source: normalized.source } : {}),
          ...(normalized.promptWeight !== undefined ? { promptWeight: normalized.promptWeight } : {}),
          ...(normalized.promptWeightBreakdown !== undefined ? { promptWeightBreakdown: normalized.promptWeightBreakdown } : {}),
        }, rawPayload,
      };
    }
    case 'error': {
      const rawPayload = args[0] as Error | string;
      return { event: { kind: 'error', message: rawPayload instanceof Error ? rawPayload.message : String(rawPayload), recoverable: false, ...extractProviderApiDiagnostics(rawPayload) }, rawPayload };
    }
    case 'complete': {
      const rawPayload = args[0] as CliResponse;
      return {
        event: {
          kind: 'complete',
          ...definedNumberField('tokensUsed', rawPayload.usage?.totalTokens),
          ...definedNumberField('costUsd', rawPayload.usage?.cost),
          ...definedNumberField('durationMs', rawPayload.usage?.duration),
          ...(rawPayload.degradedReason ? { degradedReason: rawPayload.degradedReason } : {}),
          ...extractProviderApiDiagnostics(rawPayload.metadata),
        }, rawPayload,
      };
    }
    case 'exit': {
      const code = args[0] as number | null;
      const signal = args[1] as string | null;
      return { event: { kind: 'exit', code, signal }, rawPayload: { code, signal } };
    }
    case 'spawned': {
      const rawPayload = args[0] as number;
      return { event: { kind: 'spawned', pid: rawPayload }, rawPayload };
    }
  }
}

function normalizeOutputMessage(message: OutputMessage | string): OutputMessage | null {
  if (typeof message === 'string') {
    if (!message) {
      return null;
    }

    return {
      id: randomUUID(),
      timestamp: Date.now(),
      type: 'assistant',
      content: message,
    };
  }

  if (!message || typeof message !== 'object' || typeof message.content !== 'string') {
    bridgeLogger.warn('[NORMALIZE_DROP] dropped output without string content', {
      valueType: typeof message,
      contentType: typeof (message as { content?: unknown })?.content,
      messageType: (message as { type?: unknown })?.type,
    });
    return null;
  }

  const normalized: OutputMessage = {
    id: typeof message.id === 'string' ? message.id : randomUUID(),
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
    type: normalizeOutputMessageType(message.type),
    content: message.content,
  };

  if (message.metadata && typeof message.metadata === 'object') {
    normalized.metadata = { ...message.metadata };
  }

  if (Array.isArray(message.attachments)) {
    normalized.attachments = message.attachments.map((attachment) => ({ ...attachment }));
  }

  if (Array.isArray(message.thinking)) {
    normalized.thinking = message.thinking.map((block) => ({ ...block }));
  }

  if (typeof message.thinkingExtracted === 'boolean') {
    normalized.thinkingExtracted = message.thinkingExtracted;
  }

  return normalized;
}

function normalizeContextUsage(usage: unknown): ContextUsage | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const usageRecord = usage as Record<string, unknown>;
  const used = typeof usageRecord['used'] === 'number' ? usageRecord['used'] : undefined;
  const total = typeof usageRecord['total'] === 'number' ? usageRecord['total'] : undefined;
  if (used === undefined || total === undefined) {
    return null;
  }

  const normalized: ContextUsage = {
    used,
    total,
    percentage:
      typeof usageRecord['percentage'] === 'number'
        ? usageRecord['percentage']
        : total > 0
          ? (used / total) * 100
          : 0,
  };

  if (typeof usageRecord['cumulativeTokens'] === 'number') {
    normalized.cumulativeTokens = usageRecord['cumulativeTokens'];
  }

  // Resolve input/output token counts through the shared usage normalizer so the
  // context ring reflects whichever of the 15+ provider field conventions a
  // provider emitted (input_tokens / promptTokens / prompt_tokens / completion_tokens
  // / …), not just the snake/camel pair this bridge originally handled. Behavior is
  // unchanged for `inputTokens`/`outputTokens`; only `used`/`total` (context-window
  // metrics, not token-usage fields) are intentionally read separately above.
  const usageTokens = normalizeUsage(usageRecord as unknown as UsageLike);
  if (usageTokens?.input !== undefined) {
    normalized.inputTokens = usageTokens.input;
  }
  if (usageTokens?.output !== undefined) {
    normalized.outputTokens = usageTokens.output;
  }

  const source = readString(usageRecord, ['source'], 100);
  if (source !== undefined) {
    normalized.source = source;
  }

  const promptWeight = readNumber(usageRecord, ['promptWeight', 'prompt_weight']);
  if (promptWeight !== undefined) {
    normalized.promptWeight = promptWeight;
  }

  const promptWeightBreakdown = normalizePromptWeightBreakdown(
    usageRecord['promptWeightBreakdown'] ?? usageRecord['prompt_weight_breakdown'],
  );
  if (promptWeightBreakdown !== undefined) {
    normalized.promptWeightBreakdown = promptWeightBreakdown;
  }

  if (typeof usageRecord['costEstimate'] === 'number') {
    normalized.costEstimate = usageRecord['costEstimate'];
  }

  if (typeof usageRecord['isEstimated'] === 'boolean') {
    normalized.isEstimated = usageRecord['isEstimated'];
  }

  return normalized;
}

function normalizePromptWeightBreakdown(value: unknown): ProviderPromptWeightBreakdown | undefined {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  if (!record) {
    return undefined;
  }

  const breakdown: ProviderPromptWeightBreakdown = {};
  const systemPrompt = readNumber(record, ['systemPrompt', 'system_prompt']);
  const mcpToolDescriptions = readNumber(record, ['mcpToolDescriptions', 'mcp_tool_descriptions']);
  const skills = readNumber(record, ['skills']);
  const plugins = readNumber(record, ['plugins']);
  const userPrompt = readNumber(record, ['userPrompt', 'user_prompt']);
  const other = readNumber(record, ['other']);
  if (systemPrompt !== undefined) breakdown.systemPrompt = systemPrompt;
  if (mcpToolDescriptions !== undefined) breakdown.mcpToolDescriptions = mcpToolDescriptions;
  if (skills !== undefined) breakdown.skills = skills;
  if (plugins !== undefined) breakdown.plugins = plugins;
  if (userPrompt !== undefined) breakdown.userPrompt = userPrompt;
  if (other !== undefined) breakdown.other = other;
  return Object.keys(breakdown).length > 0 ? breakdown : undefined;
}

function definedNumberField<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
  return value === undefined ? {} : { [key]: value } as Partial<Record<K, number>>;
}

function extractProviderApiDiagnostics(value: unknown): ProviderApiDiagnostics {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  if (!record) {
    return {};
  }

  const requestId = readString(record, ['requestId', 'request_id', 'x-request-id', 'anthropic-request-id']);
  const stopReason = readString(record, ['stopReason', 'stop_reason']);
  const rateLimit = normalizeRateLimit(record['rateLimit'] ?? record['rate_limit']);
  const quota = normalizeQuota(record['quota']);

  return {
    ...(requestId !== undefined ? { requestId } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(rateLimit !== undefined ? { rateLimit } : {}),
    ...(quota !== undefined ? { quota } : {}),
  };
}

function normalizeRateLimit(value: unknown): ProviderRateLimitDiagnostics | undefined {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  if (!record) {
    return undefined;
  }

  const rateLimit: ProviderRateLimitDiagnostics = {};
  const limit = readNumber(record, ['limit']);
  const remaining = readNumber(record, ['remaining']);
  const resetAt = readNumber(record, ['resetAt', 'reset_at']);
  if (limit !== undefined) rateLimit.limit = limit;
  if (remaining !== undefined) rateLimit.remaining = remaining;
  if (resetAt !== undefined) rateLimit.resetAt = resetAt;
  return Object.keys(rateLimit).length > 0 ? rateLimit : undefined;
}

function normalizeQuota(value: unknown): ProviderQuotaDiagnostics | undefined {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  if (!record) {
    return undefined;
  }

  const quota: ProviderQuotaDiagnostics = {};
  if (typeof record['exhausted'] === 'boolean') {
    quota.exhausted = record['exhausted'];
  }
  const resetAt = readNumber(record, ['resetAt', 'reset_at']);
  if (resetAt !== undefined) {
    quota.resetAt = resetAt;
  }
  const message = readString(record, ['message']);
  if (message !== undefined) {
    quota.message = message;
  }
  return Object.keys(quota).length > 0 ? quota : undefined;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function readString(record: Record<string, unknown>, keys: string[], maxLength = 300): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim();
      return trimmed.length <= maxLength ? trimmed : undefined;
    }
  }
  return undefined;
}

function normalizeOutputMessageType(type: unknown): OutputMessage['type'] {
  switch (type) {
    case 'assistant':
    case 'user':
    case 'system':
    case 'tool_use':
    case 'tool_result':
    case 'error':
      return type;
    default:
      return 'assistant';
  }
}

// ============================================
// WS-B10: unknown-event routing and tool observation normalization
// ============================================

/** Fail-closed wrapper for a recognized-but-unclassifiable adapter event. */
function buildUnknownEvent(rawType: string, payload: unknown): ProviderUnknownEvent {
  return {
    kind: 'unknown',
    rawType,
    payload: capUnknownEventPayload(payload),
    receivedAt: Date.now(),
  };
}

/**
 * Cap the serialized size of an unknown-event payload at
 * `UNKNOWN_EVENT_PAYLOAD_MAX_BYTES`. Oversized payloads are replaced with a
 * bounded preview marker rather than sent whole.
 */
function capUnknownEventPayload(value: unknown): unknown {
  const safe = toJsonSafeProviderEventPayload(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(safe) ?? 'undefined';
  } catch {
    return { truncated: true, reason: 'unserializable' };
  }
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength <= UNKNOWN_EVENT_PAYLOAD_MAX_BYTES) {
    return safe;
  }
  return {
    truncated: true,
    originalByteLength: byteLength,
    maxBytes: UNKNOWN_EVENT_PAYLOAD_MAX_BYTES,
    preview: serialized.slice(0, UNKNOWN_EVENT_PAYLOAD_MAX_BYTES),
  };
}

/**
 * Pure normalizer from a raw `CliToolCall` (tool_use phase) into the
 * `tool_use_observed` seam a future loop-detector consumes. Not wired into
 * the live `observeAdapterRuntimeEvents` stream in WS-B10 — callers that
 * want this seam invoke it directly alongside their existing `tool_use`
 * handling so today's event volume/behavior is unchanged.
 */
export function toProviderToolUseObservedEvent(toolCall: CliToolCall): ProviderToolUseObservedEvent {
  const argsHash = toolCall.arguments !== undefined ? hashStable(stableStringify(toolCall.arguments)) : undefined;
  return {
    kind: 'tool_use_observed',
    toolName: toolCall.name,
    ...(toolCall.id !== undefined ? { callId: toolCall.id } : {}),
    ...(argsHash !== undefined ? { argsHash } : {}),
    argsSummary: summarizeForObservation(toolCall.arguments),
  };
}

/**
 * Pure normalizer from a raw `CliToolCall` (tool_result phase) into the
 * `tool_result_observed` seam. See `toProviderToolUseObservedEvent` for why
 * this is not wired into the live adapter-event stream in WS-B10.
 */
export function toProviderToolResultObservedEvent(toolCall: CliToolCall): ProviderToolResultObservedEvent {
  const resultHash = toolCall.result !== undefined ? hashStable(stableStringify(toolCall.result)) : undefined;
  return {
    kind: 'tool_result_observed',
    ...(toolCall.id !== undefined ? { callId: toolCall.id } : {}),
    ...(resultHash !== undefined ? { resultHash } : {}),
    resultSummary: summarizeForObservation(toolCall.result),
  };
}

/** sha256 hex digest (first 16 chars) — matches the pattern in loop-invoker-capture.ts. */
function hashStable(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Deterministic JSON serialization (sorted keys) so equal values hash equal regardless of key order. */
function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(sortJsonKeys(value));
  } catch {
    return String(value);
  }
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJsonKeys(child)]),
  );
}

function summarizeForObservation(value: unknown, maxLength = TOOL_OBSERVATION_SUMMARY_MAX_CHARS): string {
  let text: string;
  if (value === undefined) {
    text = '';
  } else if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
