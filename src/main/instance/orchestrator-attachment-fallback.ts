import type { FileAttachment, OutputMessage } from '../../shared/types/instance.types';
import { generateId } from '../../shared/utils/id-generator';

const UNSUPPORTED_ATTACHMENTS_PATTERN =
  /does not(?: currently)? support attachments in orchestrator mode/i;

export function isUnsupportedOrchestratorAttachmentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return UNSUPPORTED_ATTACHMENTS_PATTERN.test(message);
}

export function buildUnsupportedAttachmentWarnings(
  adapterName: string,
  attachments: FileAttachment[],
): OutputMessage[] {
  const imageCount = attachments.filter((attachment) => attachment.type.startsWith('image/')).length;
  const fileCount = attachments.length - imageCount;
  const warnings: OutputMessage[] = [];

  if (imageCount > 0) {
    warnings.push({
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: `${adapterName} can't take image attachments, so ${imageCount} image${imageCount === 1 ? ' was' : 's were'} left out.`,
    });
  }

  if (fileCount > 0) {
    warnings.push({
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: `${adapterName} can't take file attachments, so ${fileCount} file${fileCount === 1 ? ' was' : 's were'} left out.`,
    });
  }

  return warnings;
}
