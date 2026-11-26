/**
 * File Handler - Saves dropped files for Claude to access via Read tool
 */

import { ensureAttachmentsIgnored } from './attachments-ignore';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { FileAttachment } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('FileHandler');

export interface ProcessedAttachment {
  originalName: string;
  filePath: string;
  isImage: boolean;
  mimeType: string;
  base64Data?: string; // Only for images
}

/**
 * Process attachments - save ALL files to working directory for Claude to read via Read tool
 * (stream-json input doesn't support inline attachments)
 * Files are saved to .claude-attachments/ in the working directory so Claude has permission
 */
export async function processAttachments(
  attachments: FileAttachment[],
  sessionId: string,
  workingDirectory: string
): Promise<ProcessedAttachment[]> {
  const results: ProcessedAttachment[] = [];

  // Save to working directory (Claude has access) instead of system temp
  const attachmentsDir = join(workingDirectory, '.claude-attachments', sessionId);
  await mkdir(attachmentsDir, { recursive: true });
  await ensureAttachmentsIgnored(workingDirectory);

  for (const attachment of attachments) {
    const isImage = attachment.type.startsWith('image/');

    // Strip data URL prefix if present
    let base64Data = attachment.data;
    if (base64Data.startsWith('data:')) {
      const commaIndex = base64Data.indexOf(',');
      if (commaIndex !== -1) {
        base64Data = base64Data.slice(commaIndex + 1);
      }
    }

    // Save ALL files to working directory (stream-json doesn't support inline attachments)
    const filePath = join(attachmentsDir, attachment.name);
    const buffer = Buffer.from(base64Data, 'base64');
    await writeFile(filePath, buffer);

    logger.debug('Saved attachment', { name: attachment.name, filePath });

    results.push({
      originalName: attachment.name,
      filePath,
      isImage,
      mimeType: attachment.type,
    });
  }

  return results;
}

/**
 * Build message with file references for ALL attached files
 */
export function buildMessageWithFiles(
  message: string,
  processedAttachments: ProcessedAttachment[]
): string {
  const fileRefs = processedAttachments
    .filter((a) => a.filePath)
    .map((a) => {
      if (a.isImage) {
        return `[Attached image: ${a.filePath}]`;
      }
      return `[Attached file: ${a.filePath}]`;
    })
    .join('\n');

  if (fileRefs) {
    return `${message}\n\nPlease read and analyze the following attached files:\n${fileRefs}`;
  }
  return message;
}
