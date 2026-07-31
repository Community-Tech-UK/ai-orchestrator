import { Injectable, inject } from '@angular/core';
import { InstanceIpcService, type PersistedQueuedMessage, type QueuedMessageDTO } from '../../services/ipc/instance-ipc.service';
import type { FileAttachment } from '../../../../../shared/types/instance.types';
import { SettingsStore } from '../settings.store';
import { ToastService } from '../../services/toast.service';
import { InstanceStateService } from './instance-state.service';
import type { QueuedMessage } from './instance.types';
import { fileToAttachments } from './instance-attachments';

/** Exponential backoff for a failed durable enqueue: 2s, 4s, 8s, 16s, 30s, 30s, then give up (stays visibly notDurable). */
const ENQUEUE_RETRY_BASE_MS = 2000;
const ENQUEUE_RETRY_MAX_MS = 30000;
const MAX_ENQUEUE_ATTEMPTS = 6;

/**
 * Thin adapter over the durable renderer send-queue (WS-A1 Phase B).
 *
 * `SessionAdmissionStore` (via SessionQueueService/IPC) is now the storage
 * authority for not-yet-sent messages — this service mirrors every queue
 * mutation into it so a renderer crash can be fully recovered, attachments
 * included, from `restoreFromDisk()`. The renderer's `stateService.messageQueue`
 * signal stays the live, synchronous source the UI renders from and
 * `instance-messaging.store.ts` keeps deciding WHEN to drain it — this class
 * only adds durability, never blocks or changes that timing.
 *
 * Association between a live in-memory `QueuedMessage` object and its durable
 * `admissionId` is tracked by object identity (`WeakMap`), not a new field on
 * `QueuedMessage` — that keeps every other consumer of the type (composer
 * queue UI, edit/cancel flows) unchanged.
 *
 * Durability failures are never silent (fresh-eyes review Finding 1): an
 * entry is marked `notDurable` from the moment it is queued until the durable
 * write is confirmed; a failed write keeps that flag set, toasts once, and
 * retries with backoff until `MAX_ENQUEUE_ATTEMPTS` is exhausted.
 */
@Injectable({ providedIn: 'root' })
export class QueuePersistenceService {
  private stateService = inject(InstanceStateService);
  private ipc = inject(InstanceIpcService);
  private settings = inject(SettingsStore);
  private toast = inject(ToastService);
  private admissionIdByEntry = new WeakMap<QueuedMessage, string>();
  private initialPromptUnsubscribe: (() => void) | null = null;

  async restoreFromDisk(): Promise<void> {
    if (!this.canPersist()) return;

    await this.migrateLegacyQueueOnce();

    const response = await this.ipc.queueList();
    if (!response.success || !response.data) return;

    this.stateService.messageQueue.update((current) => {
      const next = new Map(current);
      for (const [instanceId, rows] of Object.entries(response.data!.queues)) {
        next.set(instanceId, rows.map((row) => this.fromDurableRow(row)));
      }
      return next;
    });
  }

  subscribeToInitialPrompts(): void {
    if (this.initialPromptUnsubscribe || !this.isPauseFeatureEnabled()) return;
    this.initialPromptUnsubscribe = this.ipc.onInstanceQueueInitialPrompt((payload) => {
      if (!this.isPauseFeatureEnabled()) return;
      this.stateService.messageQueue.update((current) => {
        const next = new Map(current);
        const queue = next.get(payload.instanceId) ?? [];
        next.set(payload.instanceId, [
          ...queue,
          {
            message: payload.message,
            files: undefined,
            seededAlready: true,
            hadAttachmentsDropped: Boolean(payload.attachments?.length),
          },
        ]);
        return next;
      });
    });
  }

  unsubscribeFromInitialPrompts(): void {
    this.initialPromptUnsubscribe?.();
    this.initialPromptUnsubscribe = null;
  }

  /** No-op kept for API compatibility — mutations are persisted immediately, not debounced. */
  clearPendingSaves(): void {
    // Intentionally empty: Phase B persists each mutation directly via
    // notifyEnqueued/notifyCancelled/notifyPromoting instead of a debounced
    // full-queue snapshot, so there is nothing pending to cancel.
  }

  // ---- Called by InstanceMessagingStore at its queue mutation points ------

  /**
   * Durable enqueue. Marks the entry `notDurable` immediately (optimistic —
   * cleared once the write is confirmed) and returns a promise the caller may
   * ignore (fire-and-forget UX) or await (tests). A no-op if the entry is
   * already tracked (e.g. rebound from a steer conversion).
   */
  notifyEnqueued(instanceId: string, entry: QueuedMessage, _position: 'front' | 'back' | 'steer'): Promise<void> {
    if (!this.canPersist() || this.admissionIdByEntry.has(entry)) return Promise.resolve();
    this.setDurabilityFlag(instanceId, entry, true);
    return this.doEnqueue(instanceId, entry, 0);
  }

  /** Fire-and-forget durable cancel for entries leaving the queue without being sent. */
  notifyCancelled(instanceId: string, entries: QueuedMessage | QueuedMessage[]): void {
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      const admissionId = this.admissionIdByEntry.get(entry);
      if (!admissionId) continue;
      this.admissionIdByEntry.delete(entry);
      void this.ipc.queueCancel(admissionId).catch((error) => {
        console.warn('QueuePersistenceService: failed to cancel durable queue row', error);
      });
    }
  }

  /**
   * Awaited promote — called right before the actual send IPC, and BEFORE the
   * caller removes the entry from `stateService.messageQueue` (Finding 2), so
   * a promote failure leaves the message visibly queued for the next
   * drain/watchdog tick instead of silently proceeding to send anyway.
   *
   * Returns `true` when it is safe to proceed (either promoted successfully,
   * or nothing was tracked — e.g. persistence disabled/never durable, in
   * which case there is nothing to gate on). Returns `false` only when a
   * TRACKED entry's promote call itself failed — the caller must leave the
   * entry in the queue and retry later.
   */
  async notifyPromoting(instanceId: string, entry: QueuedMessage): Promise<boolean> {
    const admissionId = this.admissionIdByEntry.get(entry);
    if (!admissionId) return true;
    try {
      const response = await this.ipc.queuePromote(admissionId);
      if (!response.success) {
        console.warn('QueuePersistenceService: promote rejected', { instanceId, error: response.error });
        return false;
      }
      this.admissionIdByEntry.delete(entry);
      return true;
    } catch (error) {
      console.warn('QueuePersistenceService: failed to promote durable queue row', { instanceId, error });
      return false;
    }
  }

  /** Move an entry's durable-row association to a new object (e.g. steerQueuedMessage's `{...queuedMessage, kind: 'steer'}` spread). */
  rebindEntry(oldEntry: QueuedMessage, newEntry: QueuedMessage): void {
    const admissionId = this.admissionIdByEntry.get(oldEntry);
    if (!admissionId) return;
    this.admissionIdByEntry.delete(oldEntry);
    this.admissionIdByEntry.set(newEntry, admissionId);
    newEntry.notDurable = oldEntry.notDurable;
  }

  // ---- Internals ------------------------------------------------------------

  private async doEnqueue(instanceId: string, entry: QueuedMessage, attempt: number): Promise<void> {
    try {
      const attachments = entry.files && entry.files.length > 0 ? await this.filesToAttachments(entry.files) : undefined;
      const response = await this.ipc.queueEnqueue(instanceId, {
        message: entry.message,
        attachments,
        sourceMetadata: {
          kind: entry.kind,
          retryCount: entry.retryCount,
          seededAlready: entry.seededAlready,
        },
      });
      if (response.success && response.data) {
        this.admissionIdByEntry.set(entry, response.data.admissionId);
        this.setDurabilityFlag(instanceId, entry, false);
        return;
      }
      this.handleEnqueueFailure(instanceId, entry, attempt, response.error?.message ?? 'unknown error');
    } catch (error) {
      this.handleEnqueueFailure(instanceId, entry, attempt, error);
    }
  }

  /**
   * A failed durable write is never silent: the entry stays marked
   * `notDurable` (rendered as a warning next to the queued message, same
   * affordance as `hadAttachmentsDropped`), a toast fires once per failure
   * streak, and a retry is scheduled with backoff as long as the entry is
   * still actually queued.
   */
  private handleEnqueueFailure(instanceId: string, entry: QueuedMessage, attempt: number, error: unknown): void {
    console.warn('QueuePersistenceService: failed to durably enqueue message', { instanceId, attempt, error });
    this.setDurabilityFlag(instanceId, entry, true);
    if (attempt === 0) {
      this.toast.show('A queued message could not be saved for crash recovery — it will keep retrying.', 'error');
    }
    if (attempt >= MAX_ENQUEUE_ATTEMPTS - 1) return;
    const delay = Math.min(ENQUEUE_RETRY_BASE_MS * 2 ** attempt, ENQUEUE_RETRY_MAX_MS);
    setTimeout(() => {
      if (!this.isStillQueued(instanceId, entry)) return; // sent/cancelled meanwhile — nothing left to persist
      void this.doEnqueue(instanceId, entry, attempt + 1);
    }, delay);
  }

  private isStillQueued(instanceId: string, entry: QueuedMessage): boolean {
    return (this.stateService.messageQueue().get(instanceId) ?? []).includes(entry);
  }

  /** Mutates the entry in place (preserving WeakMap identity) and touches the outer Map so signal-reading templates re-render. */
  private setDurabilityFlag(instanceId: string, entry: QueuedMessage, notDurable: boolean): void {
    if (entry.notDurable === notDurable) return;
    entry.notDurable = notDurable;
    if (!this.isStillQueued(instanceId, entry)) return;
    this.stateService.messageQueue.update((current) => new Map(current));
  }

  private async filesToAttachments(files: File[]): Promise<FileAttachment[] | undefined> {
    try {
      return (await Promise.all(files.map((f) => fileToAttachments(f)))).flat();
    } catch (error) {
      // Durability is additive — an attachment that fails to convert here
      // just means this queued message isn't crash-safe; it must never block
      // the (unaffected) local queue/send behavior.
      console.warn('QueuePersistenceService: failed to convert files for durable staging', error);
      return undefined;
    }
  }

  private async migrateLegacyQueueOnce(): Promise<void> {
    const legacy = await this.ipc.instanceQueueLoadAll();
    if (!legacy.success || !legacy.data) return;
    const queues = legacy.data.queues ?? {};
    const instanceIds = Object.keys(queues);
    if (instanceIds.length === 0) return; // already migrated (or never had legacy entries)

    for (const instanceId of instanceIds) {
      for (const entry of queues[instanceId]) {
        await this.migrateLegacyEntry(instanceId, entry);
      }
      await this.ipc.instanceQueueSave(instanceId, []).catch(() => undefined);
    }
  }

  private async migrateLegacyEntry(instanceId: string, entry: PersistedQueuedMessage): Promise<void> {
    try {
      await this.ipc.queueEnqueue(instanceId, {
        message: entry.message,
        sourceMetadata: {
          hadAttachmentsDropped: entry.hadAttachmentsDropped,
          kind: entry.kind,
          retryCount: entry.retryCount,
          seededAlready: entry.seededAlready,
        },
      });
    } catch (error) {
      console.warn('QueuePersistenceService: failed to migrate legacy queue entry', { instanceId, error });
    }
  }

  private fromDurableRow(row: QueuedMessageDTO): QueuedMessage {
    const files = row.attachments.length > 0
      ? row.attachments.map((a) => dataUrlToFile(a.name, a.type, a.data))
      : undefined;
    const msg: QueuedMessage = {
      message: row.message,
      files,
      retryCount: row.sourceMetadata?.retryCount,
      kind: row.sourceMetadata?.kind,
      seededAlready: row.sourceMetadata?.seededAlready,
      // Never silent (Finding 3): a partial/failed content-store resolve on
      // the main side (row.attachmentsDropped) shows the same warning as a
      // legacy-imported row that never had attachment bytes at all.
      hadAttachmentsDropped: row.attachmentsDropped || Boolean(row.sourceMetadata?.hadAttachmentsDropped),
    };
    this.admissionIdByEntry.set(msg, row.admissionId);
    return msg;
  }

  private canPersist(): boolean {
    return this.isPauseFeatureEnabled() && this.settings.get('persistSessionContent');
  }

  private isPauseFeatureEnabled(): boolean {
    return this.settings.isInitialized() && this.settings.get('pauseFeatureEnabled');
  }
}

/** Reconstruct a browser File from a base64 data URL — restores real attachments after a crash. */
function dataUrlToFile(name: string, type: string, dataUrl: string): File {
  const commaIndex = dataUrl.indexOf(',');
  const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type });
}
