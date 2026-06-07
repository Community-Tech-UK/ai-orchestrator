import type { FileAttachment } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { ndjsonSafeStringify } from '../adapters/base-cli-adapter';
import { processAttachments, buildMessageWithFiles } from '../file-handler';

export async function formatClaudeWorkerInput(
  message: string,
  attachments: FileAttachment[] | undefined,
  sessionId: string | null,
  workingDirectory: string | undefined,
): Promise<string> {
  const imageAttachments = attachments?.filter((a) => a.type?.startsWith('image/')) ?? [];
  const otherAttachments = attachments?.filter((a) => !a.type?.startsWith('image/')) ?? [];
  let finalMessage = message;
  if (otherAttachments.length > 0 && workingDirectory) {
    const processed = await processAttachments(
      otherAttachments,
      sessionId ?? generateId(),
      workingDirectory,
    );
    finalMessage = buildMessageWithFiles(message, processed);
  }
  const content = imageAttachments.length > 0
    ? [
        ...(finalMessage.trim() ? [{ type: 'text', text: finalMessage }] : []),
        ...imageAttachments.map((attachment) => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.type,
            data: attachment.data.startsWith('data:')
              ? attachment.data.slice(attachment.data.indexOf(',') + 1)
              : attachment.data,
          },
        })),
      ]
    : finalMessage;
  return `${ndjsonSafeStringify({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  })}\n`;
}
