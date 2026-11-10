import { generateId } from '../../../shared/utils/id-generator';
import type { FileAttachment, OutputMessage } from '../../../shared/types/instance.types';
import type { PersonInputOrigin } from '../../../shared/types/input-provenance.types';
import { personInputOrigin } from '../../instance/person-input-origin';

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
  origin?: PersonInputOrigin,
): OutputMessage {
  return {
    id: generateId(),
    timestamp: Date.now(),
    type: 'user',
    content: message,
    ...(origin ? { metadata: { inputOrigin: personInputOrigin(origin) } } : {}),
    attachments: attachments?.map((attachment) => ({
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      data: attachment.data,
    })),
  };
}
