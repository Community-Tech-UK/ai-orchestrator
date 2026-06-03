import { generateId } from '../../../shared/utils/id-generator';
import type { InstanceCreateConfig, OutputMessage } from '../../../shared/types/instance.types';

export function getSeededInitialUserMessage(config: InstanceCreateConfig): OutputMessage | undefined {
  const outputBuffer = config.initialOutputBuffer;
  if (!outputBuffer || outputBuffer.length === 0) {
    return undefined;
  }

  const lastMessage = outputBuffer[outputBuffer.length - 1];
  const expectedAttachmentCount = config.attachments?.length ?? 0;
  const actualAttachmentCount = lastMessage.attachments?.length ?? 0;

  if (
    lastMessage.type === 'user'
    && lastMessage.content === (config.initialPrompt ?? '')
    && actualAttachmentCount === expectedAttachmentCount
  ) {
    return lastMessage;
  }

  return undefined;
}

export function createInitialUserMessage(config: InstanceCreateConfig): OutputMessage | undefined {
  const hasText = typeof config.initialPrompt === 'string' && config.initialPrompt.length > 0;
  const hasAttachments = Boolean(config.attachments?.length);

  if (!hasText && !hasAttachments) {
    return undefined;
  }

  return {
    id: generateId(),
    timestamp: Date.now(),
    type: 'user',
    content: config.initialPrompt ?? '',
    attachments: config.attachments?.map((attachment) => ({
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      data: attachment.data,
    })),
  };
}
