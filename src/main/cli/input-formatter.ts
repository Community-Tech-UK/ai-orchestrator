/**
 * Input Formatter - Formats and sends messages to Claude CLI stdin
 */

import type { Writable } from 'stream';
import type { FileAttachment } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import { ndjsonSafeStringify } from './adapters/base-cli-adapter';

const logger = getLogger('InputFormatter');

// Anthropic API content block types
type TextBlock = { type: 'text'; text: string };
type ImageBlock = {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
};
type ContentBlock = TextBlock | ImageBlock;

export class InputFormatter {
  private stdin: Writable;

  constructor(stdin: Writable) {
    this.stdin = stdin;
  }

  /**
   * Send a user message to the CLI
   * Uses Anthropic API format with content blocks for multimodal support
   */
  async sendMessage(message: string, attachments?: FileAttachment[]): Promise<void> {
    logger.debug('sendMessage called', {
      messagePreview: message.substring(0, 50),
      attachmentsCount: attachments?.length ?? 0,
    });

    // Build content blocks array (Anthropic API multimodal format)
    const contentBlocks: ContentBlock[] = [];

    // Add text content — must be non-empty to avoid API 400 on session --resume.
    // An empty user message stored in CLI session history will cause
    // "user messages must have non-empty content" when the session is replayed.
    const hasAttachments = attachments && attachments.length > 0;
    if (message && message.trim()) {
      contentBlocks.push({ type: 'text', text: message });
    } else if (!hasAttachments) {
      logger.warn('Blocked attempt to send empty message to CLI — no text and no attachments');
      throw new Error('Cannot send empty message to CLI: message and attachments are both empty');
    }
    // When message is empty but attachments exist, the image blocks carry the content

    // Add image attachments as inline base64 content blocks
    if (hasAttachments) {
      for (const att of attachments) {
        if (att.type.startsWith('image/')) {
          contentBlocks.push(this.formatImageBlock(att));
        }
        // Non-image files would need different handling (file paths)
      }
    }

    // Claude CLI stream-json input format.
    // Use simple string content for text-only messages; array for multimodal.
    const textContent = contentBlocks.length === 1 && contentBlocks[0].type === 'text'
      ? (contentBlocks[0] as TextBlock).text  // Use the block's text, not the raw message arg
      : contentBlocks;

    const inputMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: textContent,
      },
    };

    await this.writeToStdin(inputMessage);
  }

  /**
   * Send a raw string to stdin (for non-JSON mode)
   */
  async sendRaw(content: string): Promise<void> {
    logger.debug('sendRaw called', { contentLength: content.length });
    return new Promise((resolve, reject) => {
      const success = this.stdin.write(content + '\n', 'utf-8', (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });

      if (!success) {
        // Handle backpressure
        this.stdin.once('drain', () => resolve());
      }
    });
  }

  /**
   * Write JSON message to stdin
   */
  private async writeToStdin(message: Record<string, unknown>): Promise<void> {
    const json = ndjsonSafeStringify(message);
    logger.debug('Sending JSON to stdin', { jsonLength: json.length });
    return this.sendRaw(json);
  }

  /**
   * Convert FileAttachment to Anthropic API image content block
   */
  private formatImageBlock(attachment: FileAttachment): ImageBlock {
    // Strip data URL prefix if present (e.g., "data:image/png;base64,")
    let base64Data = attachment.data;
    if (base64Data.startsWith('data:')) {
      const commaIndex = base64Data.indexOf(',');
      if (commaIndex !== -1) {
        base64Data = base64Data.slice(commaIndex + 1);
      }
    }

    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.type,
        data: base64Data,
      },
    };
  }

  /**
   * Close the stdin stream
   */
  close(): void {
    this.stdin.end();
  }

  /**
   * Check if stdin is writable
   */
  isWritable(): boolean {
    return this.stdin.writable;
  }
}
