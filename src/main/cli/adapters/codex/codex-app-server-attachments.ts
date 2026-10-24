import type { FileAttachment } from '../../../../shared/types/instance.types';
import type { UserInput } from './app-server-types';
import { generateId } from '../../../../shared/utils/id-generator';
import { buildMessageWithFiles, processAttachments } from '../../file-handler';
import { supportsCodexInlineImage } from './attachments';

export async function prepareCodexAppServerAttachments(
  message: string, attachments: FileAttachment[], workingDirectory: string, sessionId: string | null,
): Promise<{ input: UserInput[]; text: string }> {
  if (attachments.length === 0) return { input: [], text: message };
  const processed = await processAttachments(
    attachments,
    sessionId || generateId(),
    workingDirectory,
  );
  if (processed.length === 0) return { input: [], text: message };

  const imageInputs: UserInput[] = processed
    .filter((attachment) => attachment.isImage && supportsCodexInlineImage(attachment.mimeType))
    .map((attachment) => ({ type: 'localImage', path: attachment.filePath }));
  const fileAttachments = processed.filter(
    (attachment) => !attachment.isImage || !supportsCodexInlineImage(attachment.mimeType),
  );
  return {
    input: imageInputs,
    text: fileAttachments.length > 0
      ? buildMessageWithFiles(message, fileAttachments)
      : message,
  };
}
