/**
 * SessionQueueService — durable ownership of the renderer's not-yet-sent
 * send-while-busy queue (WS-A1 Phase B).
 *
 * The renderer's `stateService.messageQueue` signal remains the fast local
 * source of truth the UI renders from and instance-messaging.store.ts keeps
 * deciding WHEN to drain it (send-while-busy timing is unchanged). This
 * service makes that queue durable: every enqueue/update/cancel/reorder is
 * mirrored into `prompt_admissions` (via `SessionAdmissionStore`) so a
 * renderer crash can be recovered from `listQueue()`, attachments included.
 *
 * Promotion (`promoteQueuedMessage`) is the sole handoff point from "queued"
 * to "about to be sent" and is a compare-and-swap in the store — a duplicate
 * promote request for the same admissionId is a safe no-op, which is what
 * makes "renderer decides when to send" safe to call more than once (e.g. a
 * retried IPC call after a dropped response).
 *
 * `SessionAdmissionService.recordUserSend()` dedupes against a `promoting`
 * row directly at the store layer (see `findRecentPromoting`) rather than
 * depending on this service, so the two services do not depend on each
 * other — only on the shared `SessionAdmissionStore`.
 */

import { generateId } from '../../shared/utils/id-generator';
import { getRLMDatabase } from '../persistence/rlm-database';
import { SessionAdmissionStore, type AdmissionRecord } from './session-admission-store';
import { stageQueuedAttachments, resolveQueuedAttachments } from './session-queue-attachments';
import type { FileAttachment } from '../../shared/types/instance.types';

export interface QueueSourceMetadata {
  hadAttachmentsDropped?: boolean;
  kind?: 'queue' | 'steer';
  retryCount?: number;
  seededAlready?: boolean;
}

export interface QueuedMessageDTO {
  admissionId: string;
  instanceId: string;
  message: string;
  attachments: FileAttachment[];
  /** True when one or more staged attachments failed to resolve (WS-A1 review Finding 3) — never silent. */
  attachmentsDropped: boolean;
  contextBlock: string | null;
  queuePosition: number | null;
  state: 'queued' | 'promoting';
  sourceMetadata: QueueSourceMetadata | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueUserMessageRequest {
  instanceId: string;
  message: string;
  attachments?: FileAttachment[];
  contextBlock?: string;
  sourceMetadata?: QueueSourceMetadata;
}

export interface UpdateQueuedMessagePatch {
  message?: string;
  attachments?: FileAttachment[];
  contextBlock?: string;
}

function toAttachmentRefs(attachments?: FileAttachment[]): string[] {
  if (!attachments || attachments.length === 0) return [];
  return attachments.map((a) => `${a.name}:${a.type}:${a.size}`);
}

export class SessionQueueService {
  private static instance: SessionQueueService | null = null;

  static getInstance(): SessionQueueService {
    if (!SessionQueueService.instance) {
      SessionQueueService.instance = new SessionQueueService();
    }
    return SessionQueueService.instance;
  }

  /** Reset the singleton for test isolation. */
  static _resetForTesting(): void {
    SessionQueueService.instance = null;
  }

  private getStore(): SessionAdmissionStore {
    return SessionAdmissionStore.getInstance(getRLMDatabase().getRawDb());
  }

  /** Durable BEFORE ack: attachment staging and the SQLite insert both complete before this resolves. */
  async enqueueUserMessage(req: EnqueueUserMessageRequest): Promise<{ admissionId: string; queuePosition: number | null }> {
    const attachmentFiles = await stageQueuedAttachments(req.attachments);
    const record = this.getStore().createQueued({
      admissionId: generateId(),
      instanceId: req.instanceId,
      message: req.message,
      attachmentRefs: toAttachmentRefs(req.attachments),
      attachmentFiles,
      contextBlock: req.contextBlock ?? null,
      sourceMetadata: (req.sourceMetadata ?? null) as Record<string, unknown> | null,
    });
    return { admissionId: record.admissionId, queuePosition: record.queuePosition };
  }

  async updateQueuedMessage(admissionId: string, patch: UpdateQueuedMessagePatch): Promise<QueuedMessageDTO | null> {
    const attachmentFiles = patch.attachments !== undefined ? await stageQueuedAttachments(patch.attachments) : undefined;
    const record = this.getStore().updateQueuedContent(admissionId, {
      message: patch.message,
      contextBlock: patch.contextBlock,
      attachmentRefs: patch.attachments !== undefined ? toAttachmentRefs(patch.attachments) : undefined,
      attachmentFiles,
    });
    return record ? this.toDTO(record) : null;
  }

  /** Returns false when the row was not in a cancellable state (idempotent no-op). */
  cancelQueuedMessage(admissionId: string): boolean {
    return Boolean(this.getStore().cancelQueued(admissionId));
  }

  reorderQueue(instanceId: string, orderedIds: string[]): void {
    this.getStore().reorderQueued(instanceId, orderedIds);
  }

  /** Omit instanceId to list every instance's queue (used for renderer startup restore). */
  async listQueue(instanceId?: string): Promise<Record<string, QueuedMessageDTO[]>> {
    const rows = this.getStore().listQueued(instanceId);
    const grouped: Record<string, QueuedMessageDTO[]> = {};
    for (const row of rows) {
      const dto = await this.toDTO(row);
      (grouped[dto.instanceId] ??= []).push(dto);
    }
    return grouped;
  }

  /** CAS queued -> promoting. Returns null when the row is missing or already left `queued` (idempotent). */
  async promoteQueuedMessage(admissionId: string): Promise<QueuedMessageDTO | null> {
    const record = this.getStore().promoteQueued(admissionId);
    return record ? this.toDTO(record) : null;
  }

  private async toDTO(record: AdmissionRecord): Promise<QueuedMessageDTO> {
    const resolved = await resolveQueuedAttachments(record.attachmentFiles);
    return {
      admissionId: record.admissionId,
      instanceId: record.instanceId,
      message: record.message,
      attachments: resolved.attachments,
      attachmentsDropped: resolved.dropped,
      contextBlock: record.contextBlock,
      queuePosition: record.queuePosition,
      state: record.state as 'queued' | 'promoting',
      sourceMetadata: (record.sourceMetadata as QueueSourceMetadata | null) ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

export function getSessionQueueService(): SessionQueueService {
  return SessionQueueService.getInstance();
}

export function _resetSessionQueueServiceForTesting(): void {
  SessionQueueService._resetForTesting();
}
