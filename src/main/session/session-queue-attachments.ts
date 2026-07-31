/**
 * Attachment staging for the durable renderer send-queue (WS-A1 Phase B).
 *
 * `FileAttachment.data` carries the full base64 data URL in memory (see
 * `shared/types/instance.types.ts`). Storing that inline in the
 * `prompt_admissions` row would bloat the RLM SQLite file, so queued
 * attachments are staged through the same content-addressed store already
 * used for automation attachments (`AutomationAttachmentService` /
 * `getContentStore()`), which routes small payloads inline and large ones to
 * a bounded, deduplicated on-disk cache under `<userData>/content-store`. The
 * row only ever holds a lightweight `ContentRef`, never a secret or raw blob
 * outside that cache.
 */

import { getLogger } from '../logging/logger';
import { getContentStore, type ContentRef } from './content-store';
import type { FileAttachment } from '../../shared/types/instance.types';

const logger = getLogger('SessionQueueAttachments');

export interface QueuedAttachmentFileRef {
  name: string;
  type: string;
  size: number;
  contentRef: ContentRef;
}

/** Persist attachment content durably (awaits the disk write) and return refs to store on the row. */
export async function stageQueuedAttachments(
  attachments: FileAttachment[] | undefined,
): Promise<QueuedAttachmentFileRef[]> {
  if (!attachments || attachments.length === 0) return [];
  const store = getContentStore();
  const staged: QueuedAttachmentFileRef[] = [];
  for (const attachment of attachments) {
    if (!attachment.data) {
      // Nothing to persist for an attachment carrying no content — skip
      // rather than throw, matching this module's fail-soft-toward-content
      // philosophy (a dropped attachment surfaces to the user via
      // hadAttachmentsDropped, never a queue-blocking error).
      logger.warn('Queued attachment has no data to persist; dropping', { name: attachment.name });
      continue;
    }
    staged.push({
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      contentRef: await store.storeDurable(attachment.data),
    });
  }
  return staged;
}

export interface ResolvedQueuedAttachments {
  attachments: FileAttachment[];
  /** True when at least one staged attachment failed to resolve (missing/corrupt content-store blob). */
  dropped: boolean;
}

/**
 * Resolve staged refs back into full FileAttachment payloads for restore/send.
 *
 * A missing/corrupt content-store blob must never crash a queue restore, but
 * silently dropping the attachment would hide real data loss from the user —
 * `dropped` surfaces that so the caller can mark the message (e.g. the
 * existing `hadAttachmentsDropped` UI affordance), even when other
 * attachments on the same message resolved fine.
 */
export async function resolveQueuedAttachments(
  refs: QueuedAttachmentFileRef[] | undefined,
): Promise<ResolvedQueuedAttachments> {
  if (!refs || refs.length === 0) return { attachments: [], dropped: false };
  const store = getContentStore();
  const attachments: FileAttachment[] = [];
  let dropped = false;
  for (const ref of refs) {
    try {
      attachments.push({
        name: ref.name,
        type: ref.type,
        size: ref.size,
        data: await store.resolve(ref.contentRef),
      });
    } catch (err) {
      // Missing/corrupt staged content must never crash a queue restore —
      // drop the one attachment and keep the rest of the message intact.
      dropped = true;
      logger.warn('Failed to resolve staged queue attachment (dropping)', {
        name: ref.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { attachments, dropped };
}
