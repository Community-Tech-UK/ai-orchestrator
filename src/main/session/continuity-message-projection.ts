import { retrievedContextDeliveriesOf, retrievedContextMetadataOf } from '../../shared/utils/input-context-delivery';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { OutputMessage } from '../../shared/types/instance.types';
import type { ConversationEntry } from './session-continuity.types';
import { noticeToMetadata, readNoticeMetadata } from './continuity-notice-metadata';

function metadataString(
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function metadataNumber(
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function compactionFlag(metadata: Record<string, unknown> | undefined): boolean | undefined {
  if (typeof metadata?.['isCompacted'] === 'boolean') return metadata['isCompacted'];
  if (metadata?.['isCompactionBoundary'] === true || metadata?.['threadCompacted'] === true) {
    return true;
  }
  return undefined;
}

function metadataBoolean(
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[],
): boolean | undefined {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function metadataTokenUsage(
  metadata: Record<string, unknown> | undefined,
): NonNullable<ConversationEntry['tokenUsage']> | undefined {
  const raw = metadata?.['tokenUsage'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const usage: NonNullable<ConversationEntry['tokenUsage']> = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) usage[key] = value;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Metadata keys naming a tool call's id. `toolCallId` is the ACP adapter's key
 * (Copilot, Cursor); without it their calls and results never correlated, and
 * transcript repair fabricated an "interrupted" result for every call.
 */
const TOOL_CALL_ID_KEYS = ['id', 'toolUseId', 'tool_use_id', 'toolCallId'] as const;
const TOOL_RESULT_FOR_KEYS = ['tool_use_id', 'toolUseId', 'toolCallId', 'id'] as const;

/** Project a visible runtime message into the typed continuity representation. */
export function outputMessageToContinuityEntry(
  message: OutputMessage,
  toolNamesByCallId?: Map<string, string>,
): ConversationEntry {
  const role: ConversationEntry['role'] = message.type === 'user'
    ? 'user'
    : message.type === 'assistant' || message.type === 'tool_use'
      ? 'assistant'
      : message.type === 'tool_result'
        ? 'tool'
        : 'system';
  const thinking = message.thinking
    ?.map((item) => item.content)
    .filter((content) => content.length > 0)
    .join('\n');
  const tokens = metadataNumber(message.metadata, ['tokens', 'tokensUsed', 'tokenCount']);
  const tokenUsage = metadataTokenUsage(message.metadata);
  const isCompacted = compactionFlag(message.metadata);
  const toolCallId = message.type === 'tool_use'
    ? metadataString(message.metadata, TOOL_CALL_ID_KEYS)
    : undefined;
  const toolResultFor = message.type === 'tool_result'
    ? metadataString(message.metadata, TOOL_RESULT_FOR_KEYS)
    : undefined;
  const explicitToolName = message.type === 'tool_use' || message.type === 'tool_result'
    ? metadataString(message.metadata, ['toolName', 'name'])
    : undefined;
  if (toolCallId && explicitToolName) toolNamesByCallId?.set(toolCallId, explicitToolName);
  const toolName = message.type === 'tool_use' || message.type === 'tool_result'
    ? explicitToolName ?? (toolResultFor ? toolNamesByCallId?.get(toolResultFor) : undefined) ?? 'tool'
    : undefined;
  const compactionMarkerId = metadataString(message.metadata, ['compactionMarkerId']);
  const compactionMethod = metadataString(message.metadata, ['method', 'compactionMethod']);
  const internalInput = message.metadata?.internalInput;
  const crossSessionMessage = message.metadata?.crossSessionMessage;
  // The restart divider is a transcript reset (`isTranscriptReset`) and the
  // marker `activeMessagesOf`/`isSessionBoundaryMessage` filter on. Its `kind`
  // must survive continuity: hibernate/wake rebuilds the visible buffer from
  // these entries, and a marker that lost its kind no longer stops
  // `read_session`'s before-last-compaction read at the reset.
  const sessionBoundaryArchived = metadataBoolean(message.metadata, ['archived']);
  const sessionBoundary = message.metadata?.['kind'] === 'session-boundary'
    ? { ...(sessionBoundaryArchived === undefined ? {} : { archived: sessionBoundaryArchived }) }
    : undefined;
  // A command's own exit status and check verdict ride beside `is_error` (which only
  // means "could not run"), so a failed check is still failed after a restore.
  const exitCode = (message.type === 'tool_result' || message.type === 'tool_use') ? metadataNumber(message.metadata, ['exitCode']) : undefined;
  const isCheck = (message.type === 'tool_result' || message.type === 'tool_use') ? metadataBoolean(message.metadata, ['isCheck']) : undefined;
  const checkFailed = (message.type === 'tool_result' || message.type === 'tool_use') ? metadataBoolean(message.metadata, ['checkFailed']) : undefined;
  const notice = role === 'system' ? readNoticeMetadata(message) : undefined;

  return {
    ...(message.type === 'user' ? nonEmptyRetrievedContext(message.metadata) : {}),
    id: message.id,
    role,
    content: message.content,
    timestamp: message.timestamp,
    ...(internalInput ? { internalInput: { ...internalInput } } : {}),
    ...(crossSessionMessage ? { crossSessionMessage: { ...crossSessionMessage } } : {}),
    ...(message.metadata?.agentAuthored ? { agentAuthored: true } : {}),
    ...(sessionBoundary ? { sessionBoundary } : {}),
    ...(notice ? { notice } : {}),
    ...(tokens === undefined ? {} : { tokens }),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(toolName
      ? {
          toolUse: {
            kind: message.type === 'tool_result' ? 'result' : 'call',
            toolName,
            input: message.metadata?.['input'] ?? null,
            ...(toolCallId ? { callId: toolCallId } : {}),
            ...(toolResultFor ? { resultForCallId: toolResultFor } : {}),
            ...((message.type === 'tool_result' || typeof message.metadata?.['is_error'] === 'boolean')
              ? { output: metadataString(message.metadata, ['output']) ?? message.content }
              : {}),
            ...((message.type === 'tool_result' || message.type === 'tool_use')
              && metadataBoolean(message.metadata, ['isError', 'is_error']) !== undefined
              ? { isError: metadataBoolean(message.metadata, ['isError', 'is_error']) }
              : {}),
            ...(exitCode === undefined ? {} : { exitCode }),
            ...(isCheck === undefined ? {} : { isCheck }),
            ...(checkFailed === undefined ? {} : { checkFailed }),
          },
        }
      : {}),
    ...(thinking ? { thinking } : {}),
    ...(message.thinking?.length
      ? { thinkingBlocks: structuredClone(message.thinking) }
      : {}),
    ...(isCompacted === undefined ? {} : { isCompacted }),
    ...(isCompacted === undefined && !compactionMarkerId && !compactionMethod
      ? {}
      : {
          compaction: {
            boundary: isCompacted === true,
            ...(compactionMarkerId ? { markerId: compactionMarkerId } : {}),
            ...(compactionMethod ? { method: compactionMethod } : {}),
          },
        }),
  };
}

/** Project a complete visible buffer while correlating real tool-result metadata to prior calls. */
export function outputMessagesToContinuityEntries(
  messages: readonly OutputMessage[],
): ConversationEntry[] {
  const toolNamesByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.type !== 'tool_use') continue;
    const callId = metadataString(message.metadata, TOOL_CALL_ID_KEYS);
    const toolName = metadataString(message.metadata, ['toolName', 'name']);
    if (callId && toolName) toolNamesByCallId.set(callId, toolName);
  }
  return messages.map((message) => outputMessageToContinuityEntry(message, toolNamesByCallId));
}

/** Project non-output canonical provider events into durable continuity entries. */
export function providerRuntimeEnvelopeToContinuityEntry(
  envelope: ProviderRuntimeEventEnvelope,
  toolNamesByCallId?: Map<string, string>,
): ConversationEntry | null {
  const { event } = envelope;
  if (event.kind === 'output') return null;
  if (event.kind === 'tool_use') {
    const callId = event.toolUseId?.trim();
    if (callId && event.toolName) toolNamesByCallId?.set(callId, event.toolName);
    // Continuity replaces entries by id, so the id carries the adapter
    // generation: a respawned adapter that reuses a call id must not overwrite
    // the previous run's call.
    const generation = envelope.adapterGeneration === undefined ? '' : `g${envelope.adapterGeneration}:`;
    return {
      id: `tool-call:${generation}${callId || envelope.eventId}`,
      role: 'assistant',
      content: '',
      timestamp: envelope.timestamp,
      toolUse: {
        kind: 'call',
        toolName: event.toolName || 'tool',
        ...(callId ? { callId } : {}),
        input: structuredClone(event.input ?? null),
      },
    };
  }
  if (event.kind === 'tool_result') {
    const callId = event.toolUseId?.trim();
    const content = event.output ?? event.error ?? '';
    return {
      id: `tool-result:${callId || 'unmatched'}:${envelope.eventId}`,
      role: 'tool',
      content,
      timestamp: envelope.timestamp,
      toolUse: {
        kind: 'result',
        toolName: event.toolName || (callId ? toolNamesByCallId?.get(callId) : undefined) || 'tool',
        ...(callId ? { resultForCallId: callId } : {}),
        input: null,
        output: content,
        isError: event.success === false,
      },
    };
  }
  return null;
}

/** Restore typed continuity into a visible runtime message, including legacy tool records. */
export function continuityEntryToOutputMessage(entry: ConversationEntry): OutputMessage {
  const type: OutputMessage['type'] = entry.role === 'user'
    ? 'user'
    : entry.role === 'tool'
      ? 'tool_result'
      : entry.toolUse
        ? 'tool_use'
        : entry.role;
  const metadata = entry.toolUse
    || entry.tokens !== undefined
    || entry.tokenUsage
    || entry.isCompacted !== undefined
    || entry.compaction
    || entry.sessionBoundary
    || entry.internalInput
    || entry.crossSessionMessage
    || entry.agentAuthored
    || entry.notice
    || entry.retrievedContextDeliveries
    || entry.retrievedContextMetadata
    ? {
        ...(entry.toolUse
          ? {
              toolName: entry.toolUse.toolName,
              input: structuredClone(entry.toolUse.input),
              ...(entry.toolUse.callId ? { id: entry.toolUse.callId } : {}),
              ...(entry.toolUse.resultForCallId
                ? { tool_use_id: entry.toolUse.resultForCallId }
                : {}),
              ...(entry.toolUse.output === undefined ? {} : { output: entry.toolUse.output }),
              ...(entry.toolUse.isError === undefined ? {} : { is_error: entry.toolUse.isError }),
              ...(entry.toolUse.exitCode === undefined ? {} : { exitCode: entry.toolUse.exitCode }),
              ...(entry.toolUse.isCheck === undefined ? {} : { isCheck: entry.toolUse.isCheck }),
              ...(entry.toolUse.checkFailed === undefined ? {} : { checkFailed: entry.toolUse.checkFailed }),
            }
          : {}),
        ...noticeToMetadata(entry.notice),
        ...(entry.retrievedContextDeliveries ? { retrievedContextDeliveries: { ...entry.retrievedContextDeliveries } } : {}),
        ...retrievedContextMetadataOf(entry.retrievedContextMetadata),
        ...(entry.tokens === undefined ? {} : { tokens: entry.tokens }),
        ...(entry.tokenUsage ? { tokenUsage: structuredClone(entry.tokenUsage) } : {}),
        ...(entry.isCompacted === undefined ? {} : { isCompacted: entry.isCompacted }),
        ...(entry.compaction?.markerId ? { compactionMarkerId: entry.compaction.markerId } : {}),
        ...(entry.compaction?.method ? { method: entry.compaction.method } : {}),
        ...(entry.compaction ? { isCompactionBoundary: entry.compaction.boundary } : {}),
        ...(entry.sessionBoundary
          ? {
              kind: 'session-boundary',
              ...(entry.sessionBoundary.archived === undefined
                ? {}
                : { archived: entry.sessionBoundary.archived }),
            }
          : {}),
        ...(entry.internalInput ? { internalInput: { ...entry.internalInput } } : {}),
        ...(entry.crossSessionMessage ? { crossSessionMessage: { ...entry.crossSessionMessage } } : {}),
        ...(entry.agentAuthored ? { agentAuthored: true } : {}),
      }
    : undefined;

  return {
    id: entry.id,
    timestamp: entry.timestamp,
    type,
    content: entry.content,
    ...(metadata ? { metadata } : {}),
    ...(entry.thinkingBlocks?.length
      ? {
          thinking: structuredClone(entry.thinkingBlocks),
          thinkingExtracted: true,
        }
      : entry.thinking
      ? {
          thinking: [{
            id: `recovery-thinking-${entry.id}`,
            content: entry.thinking,
            format: 'unknown',
            timestamp: entry.timestamp,
          }],
          thinkingExtracted: true,
        }
      : {}),
  };
}

/** Only keep retrieval records a user message really carries, so an ordinary message saves nothing extra. */
function nonEmptyRetrievedContext(metadata: Record<string, unknown> | undefined) {
  const deliveries = retrievedContextDeliveriesOf(metadata);
  const measurements = retrievedContextMetadataOf(metadata);
  return {
    ...(Object.keys(deliveries).length ? { retrievedContextDeliveries: deliveries } : {}),
    ...(Object.keys(measurements).length ? { retrievedContextMetadata: measurements } : {}),
  };
}
