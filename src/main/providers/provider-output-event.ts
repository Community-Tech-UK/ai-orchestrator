import type {
  ProviderOutputEvent,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';
import type { OutputMessage } from '../../shared/types/instance.types';

/** Convert a shared OutputMessage into a lossless ProviderOutputEvent payload. */
export function toProviderOutputEvent(message: OutputMessage): ProviderOutputEvent {
  const event: ProviderOutputEvent = {
    kind: 'output',
    content: message.content,
    messageType: message.type,
    messageId: message.id,
    timestamp: message.timestamp,
  };

  if (message.metadata !== undefined) {
    event.metadata = { ...message.metadata };
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

/** Convert a provider runtime output envelope back into the shared OutputMessage shape. */
export function toOutputMessageFromProviderEnvelope(
  envelope: ProviderRuntimeEventEnvelope,
): OutputMessage | null {
  if (envelope.event.kind !== 'output') {
    return null;
  }

  const message: OutputMessage = {
    id: envelope.event.messageId ?? envelope.eventId,
    timestamp: envelope.event.timestamp ?? envelope.timestamp,
    type: toOutputMessageType(envelope.event.messageType),
    content: envelope.event.content,
  };

  if (envelope.event.metadata !== undefined) {
    message.metadata = { ...envelope.event.metadata };
  }

  if (envelope.event.attachments !== undefined) {
    message.attachments = envelope.event.attachments.map((attachment) => ({ ...attachment }));
  }

  if (envelope.event.thinking !== undefined) {
    message.thinking = envelope.event.thinking.map((block) => ({ ...block }));
  }

  if (envelope.event.thinkingExtracted !== undefined) {
    message.thinkingExtracted = envelope.event.thinkingExtracted;
  }

  return message;
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
    case 'error':
      return messageType;
    default:
      return 'assistant';
  }
}
