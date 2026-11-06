import type {
  ProviderOutputEvent,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';
import type { OutputMessage } from '../../shared/types/instance.types';
import { withExplicitAudience } from '../../shared/utils/system-message-audience';

/**
 * Convert a shared OutputMessage into a lossless ProviderOutputEvent payload.
 * A system message leaves with an explicit audience (`attention` unless its emit
 * site said `routine`), so the default is a recorded decision rather than silence.
 */
export function toProviderOutputEvent(message: OutputMessage): ProviderOutputEvent {
  const event: ProviderOutputEvent = {
    kind: 'output',
    content: message.content,
    messageType: message.type,
    messageId: message.id,
    timestamp: message.timestamp,
  };

  const metadata = withExplicitAudience(message.type, message.metadata);
  if (metadata !== undefined) {
    event.metadata = { ...metadata };
  }

  if (message.attachments !== undefined) {
    event.attachments = message.attachments.map((attachment) => ({ ...attachment }));
  }

  if (message.thinking !== undefined) {
    event.thinking = message.thinking.map((block) => ({ ...block }));
  }

  if (message.thinkingExtracted !== undefined) {
    event.thinkingExtracted = message.thinkingExtracted;
  }

  return event;
}

export function toOutputMessageFromProviderOutputEvent(
  event: ProviderOutputEvent,
  defaults?: {
    eventId?: string;
    timestamp?: number;
    adapterGeneration?: number;
    turnId?: string;
  },
): OutputMessage {
  const message: OutputMessage = {
    id: event.messageId ?? defaults?.eventId ?? 'provider-output',
    timestamp: event.timestamp ?? defaults?.timestamp ?? Date.now(),
    type: toOutputMessageType(event.messageType),
    content: event.content,
  };

  // Not every producer goes through `toProviderOutputEvent` (an adapter's string
  // `pushOutput`, an older worker), so the default is also made explicit here.
  const metadata = withExplicitAudience(message.type, event.metadata);
  if (metadata !== undefined) {
    message.metadata = { ...metadata };
  }

  if (defaults?.adapterGeneration !== undefined || defaults?.turnId !== undefined) {
    message.metadata = {
      ...message.metadata,
      ...(defaults.adapterGeneration !== undefined ? { adapterGeneration: defaults.adapterGeneration } : {}),
      ...(defaults.turnId !== undefined ? { turnId: defaults.turnId } : {}),
    };
  }

  if (event.attachments !== undefined) {
    message.attachments = event.attachments.map((attachment) => ({ ...attachment }));
  }

  if (event.thinking !== undefined) {
    message.thinking = event.thinking.map((block) => ({ ...block }));
  }

  if (event.thinkingExtracted !== undefined) {
    message.thinkingExtracted = event.thinkingExtracted;
  }

  return message;
}

/** Convert a provider runtime output envelope back into the shared OutputMessage shape. */
export function toOutputMessageFromProviderEnvelope(
  envelope: ProviderRuntimeEventEnvelope,
): OutputMessage | null {
  if (envelope.event.kind !== 'output') {
    return null;
  }

  return toOutputMessageFromProviderOutputEvent(envelope.event, {
    eventId: envelope.eventId,
    timestamp: envelope.timestamp,
    adapterGeneration: envelope.adapterGeneration,
    turnId: envelope.turnId,
  });
}

function toOutputMessageType(
  messageType: string | undefined,
): OutputMessage['type'] {
  switch (messageType) {
    case 'assistant':
    case 'user':
    case 'system':
    case 'tool_use':
    case 'tool_result':
    // LT-196: must be preserved, not defaulted. These switches take a loose
    // `string`/`unknown`, so TypeScript never flagged the new member here —
    // and a `default: 'assistant'` relabels the miner-only outcome record as
    // an assistant message, carrying raw tool-failure text onto every live
    // consumer (mobile broadcast, continuity persistence) past their filters.
    case 'tool_outcome':
    case 'error':
      return messageType;
    default:
      return 'assistant';
  }
}
