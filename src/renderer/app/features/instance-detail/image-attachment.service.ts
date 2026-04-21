import { Injectable, inject } from '@angular/core';
import type { ImageResolveResponse } from '@contracts/schemas/image';
import type {
  FailedImageRef,
  FileAttachment,
  OutputMessage,
} from '../../../../shared/types/instance.types';
import { FileIpcService } from '../../core/services/ipc';
import { extractImageReferences } from './image-reference-extractor';

export interface ImageAttachmentSink {
  appendAttachmentsToMessage(
    instanceId: string,
    messageId: string,
    attachments: FileAttachment[],
    failedImages: FailedImageRef[],
  ): void;
  markImagesResolved(instanceId: string, messageId: string): void;
}

@Injectable({ providedIn: 'root' })
export class ImageAttachmentService {
  private readonly fileIpc = inject(FileIpcService);
  private readonly inFlight = new Set<string>();

  async processMessage(
    instanceId: string,
    message: OutputMessage,
    sink: ImageAttachmentSink,
    options: { finalized?: boolean } = {},
  ): Promise<void> {
    if (message.type !== 'assistant') {
      return;
    }

    if (message.metadata?.['imagesResolved'] === true) {
      return;
    }

    if (message.metadata?.['streaming'] === true && options.finalized !== true) {
      return;
    }

    const key = `${instanceId}:${message.id}`;
    if (this.inFlight.has(key)) {
      return;
    }
    this.inFlight.add(key);

    try {
      const references = extractImageReferences(message.content);
      if (references.length === 0) {
        sink.markImagesResolved(instanceId, message.id);
        return;
      }

      const attachments: FileAttachment[] = [];
      const failedImages: FailedImageRef[] = [];
      const seenAttachments = new Set<string>();

      const results = await Promise.all(
        references.map(async (reference) => {
          const response = await this.fileIpc.resolveImage(reference);
          return { reference, response };
        }),
      );

      for (const { reference, response } of results) {
        if (isResolveSuccess(response)) {
          const attachmentKey = `${response.attachment.name}:${response.attachment.data}`;
          if (!seenAttachments.has(attachmentKey)) {
            attachments.push(response.attachment);
            seenAttachments.add(attachmentKey);
          }
        } else {
          failedImages.push({
            src: reference.src,
            kind: reference.kind,
            reason: response?.reason ?? 'fetch_failed',
            message: response?.message ?? 'Image resolution IPC failed',
          });
        }
      }

      if (attachments.length > 0 || failedImages.length > 0) {
        sink.appendAttachmentsToMessage(instanceId, message.id, attachments, failedImages);
      }
      sink.markImagesResolved(instanceId, message.id);
    } finally {
      this.inFlight.delete(key);
    }
  }
}

function isResolveSuccess(
  response: ImageResolveResponse | null,
): response is Extract<ImageResolveResponse, { ok: true }> {
  return response?.ok === true;
}
