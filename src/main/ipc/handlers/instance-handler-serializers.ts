import { generateId } from '../../../shared/utils/id-generator';
import type { FileAttachment, OutputMessage } from '../../../shared/types/instance.types';

export function serializeInstance(
  instance: object & { communicationTokens?: unknown },
): Record<string, unknown> {
  const record = { ...(instance as Record<string, unknown>) };
  const communicationTokens = record['communicationTokens'];
  delete record['readyPromise'];
  delete record['respawnPromise'];
  delete record['abortController'];

  return {
    ...record,
    communicationTokens:
      communicationTokens instanceof Map
        ? Object.fromEntries(communicationTokens)
        : communicationTokens,
  };
}

export function createInitialUserMessage(
  message: string,
  attachments?: FileAttachment[],
): OutputMessage {
  return {
    id: generateId(),
    timestamp: Date.now(),
    type: 'user',
    content: message,
    attachments: attachments?.map((attachment) => ({
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      data: attachment.data,
    })),
  };
}
