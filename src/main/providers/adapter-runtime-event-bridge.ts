import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'events';
import type { CliResponse, CliToolCall } from '../cli/adapters/base-cli-adapter';
import { toProviderOutputEvent } from './provider-output-event';
import type { ContextUsage, OutputMessage } from '../../shared/types/instance.types';
import type { ProviderRuntimeEvent } from '@contracts/types/provider-runtime-events';

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
  | NormalizedAdapterRuntimeEventBase<'spawned', number>;

export function observeAdapterRuntimeEvents(
  adapter: AdapterRuntimeEventSource,
  onEvent: (event: NormalizedAdapterRuntimeEvent) => void,
): () => void {
  const emit = <K extends ProviderRuntimeEventKind>(
    event: ProviderRuntimeEventOfKind<K>,
    rawPayload: NormalizedAdapterRuntimeRawPayload<K>,
    timestamp = Date.now(),
  ): void => {
    const normalizedEvent: NormalizedAdapterRuntimeEventBase<K, NormalizedAdapterRuntimeRawPayload<K>> = {
      kind: event.kind,
      eventId: randomUUID(),
      timestamp,
      event,
      rawPayload,
    };

    onEvent(normalizedEvent as NormalizedAdapterRuntimeEvent);
  };

  const onOutput = (message: OutputMessage | string): void => {
    const normalized = normalizeOutputMessage(message);
    if (!normalized) {
      return;
    }
    emit(toProviderOutputEvent(normalized), message, normalized.timestamp);
  };

  const onToolUse = (toolCall: CliToolCall): void => {
    emit({
      kind: 'tool_use',
      toolName: toolCall.name,
      toolUseId: toolCall.id,
      input: toolCall.arguments,
    }, toolCall);
  };

  const onToolResult = (toolCall: CliToolCall): void => {
    emit({
      kind: 'tool_result',
      toolName: toolCall.name,
      toolUseId: toolCall.id,
      success: true,
      output: toolCall.result,
    }, toolCall);
  };

  const onStatus = (status: string): void => {
    emit({ kind: 'status', status }, status);
  };

  const onContext = (usage: unknown): void => {
    const normalized = normalizeContextUsage(usage);
    if (!normalized) {
      return;
    }

    emit({
      kind: 'context',
      used: normalized.used,
      total: normalized.total,
      percentage: normalized.percentage,
    }, normalized);
  };

  const onError = (error: Error | string): void => {
    emit({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      recoverable: false,
    }, error);
  };

  const onComplete = (response: CliResponse): void => {
    emit({
      kind: 'complete',
      tokensUsed: response.usage?.totalTokens,
      costUsd: response.usage?.cost,
      durationMs: response.usage?.duration,
    }, response);
  };

  const onExit = (code: number | null, signal: string | null): void => {
    emit({ kind: 'exit', code, signal }, { code, signal });
  };

  const onSpawned = (pid: number): void => {
    emit({ kind: 'spawned', pid }, pid);
  };

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

  if (typeof usageRecord['costEstimate'] === 'number') {
    normalized.costEstimate = usageRecord['costEstimate'];
  }

  if (typeof usageRecord['isEstimated'] === 'boolean') {
    normalized.isEstimated = usageRecord['isEstimated'];
  }

  return normalized;
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
