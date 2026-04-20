import type { ProviderOutputEvent } from '@contracts/types/provider-runtime-events';
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
