/**
 * Instance Messaging Store - Manages message queue and sending
 *
 * Handles message queuing when instance is busy and message sending.
 */

import { effect, Injectable, inject } from '@angular/core';
import { ElectronIpcService } from '../../services/ipc';
import { DraftService } from '../../services/draft.service';
import { InstanceStateService } from './instance-state.service';
import { InstanceListStore } from './instance-list.store';
import type { InstanceStatus, OutputMessage, QueuedMessage } from './instance.types';
import { PauseStore } from '../pause/pause.store';

/** Maximum number of transient-failure retries before dropping a queued message. */
const MAX_QUEUE_RETRIES = 3;

interface SendInputImmediateOptions {
  skipUserBubble?: boolean;
  queuedMetadata?: Pick<QueuedMessage, 'kind' | 'hadAttachmentsDropped' | 'seededAlready'>;
}

function isTransientQueueStatus(status: InstanceStatus): boolean {
  return status === 'busy'
    || status === 'processing'
    || status === 'thinking_deeply'
    || status === 'waiting_for_permission'
    || status === 'respawning'
    || status === 'interrupting'
    || status === 'cancelling'
    || status === 'interrupt-escalating'
    || status === 'initializing'
    || status === 'waking'
    || status === 'hibernating'
    || status === 'degraded';
}

function isActiveTurnStatus(status: InstanceStatus | undefined): boolean {
  return status === 'busy'
    || status === 'processing'
    || status === 'thinking_deeply'
    || status === 'waiting_for_permission';
}

function isInterruptRecoveryStatus(status: InstanceStatus | undefined): boolean {
  return status === 'respawning'
    || status === 'interrupting'
    || status === 'cancelling'
    || status === 'interrupt-escalating';
}

function isReadyForInputStatus(status: InstanceStatus | undefined): boolean {
  return status === 'idle'
    || status === 'ready'
    || status === 'waiting_for_input';
}

function isTerminalStatus(status: InstanceStatus | undefined): boolean {
  return status === 'failed'
    || status === 'error'
    || status === 'terminated'
    || status === 'cancelled'
    || status === 'superseded';
}

@Injectable({ providedIn: 'root' })
export class InstanceMessagingStore {
  private stateService = inject(InstanceStateService);
  private ipc = inject(ElectronIpcService);
  private listStore = inject(InstanceListStore);
  private draftService = inject(DraftService);
  private pauseStore = inject(PauseStore);
  private queueWatchdog: ReturnType<typeof setInterval> | null = null;
  private interruptRequests = new Map<string, number>();
  private static readonly RECENT_INTERRUPT_MS = 5000;

  constructor() {
    effect(() => {
      let total = 0;
      for (const queue of this.stateService.messageQueue().values()) {
        total += queue.length;
      }
      this.pauseStore.queuedTotal.set(total);
    });

    // Watchdog: periodically check for stuck queue items.
    // The primary drain trigger is applyBatchUpdates on idle transitions,
    // but timing/batching edge cases can leave messages stuck. This catches them.
    this.queueWatchdog = setInterval(() => this.drainAllReadyQueues(), 2000);
  }

  /**
   * Process queued messages for all instances that are currently idle,
   * and clear queues for instances that are in terminal states.
   * Acts as a safety net for cases where the primary drain trigger misses.
   */
  private drainAllReadyQueues(): void {
    const queueMap = this.stateService.messageQueue();
    if (queueMap.size === 0) return;

    for (const [instanceId] of queueMap) {
      const instance = this.stateService.getInstance(instanceId);
      if (!instance) {
        // Instance no longer exists — clean up orphaned queue
        this.clearMessageQueue(instanceId);
        continue;
      }

      if (instance.status === 'idle' || instance.status === 'ready' || instance.status === 'waiting_for_input') {
        this.processMessageQueue(instanceId);
      } else if (
        instance.status === 'failed'
        || instance.status === 'error'
        || instance.status === 'terminated'
        || instance.status === 'cancelled'
        || instance.status === 'superseded'
      ) {
        // Terminal state: messages can never be delivered — clear with notification
        this.clearQueueWithNotification(instanceId);
      }
    }
  }

  // ============================================
  // Message Queue Management
  // ============================================

  /**
   * Get queued message count for an instance (reactive)
   */
  getQueuedMessageCount(instanceId: string): number {
    return this.stateService.messageQueue().get(instanceId)?.length || 0;
  }

  /**
   * Get the message queue for an instance (reactive)
   */
  getMessageQueue(instanceId: string): QueuedMessage[] {
    return this.stateService.messageQueue().get(instanceId) || [];
  }

  /**
   * Clear the message queue for an instance
   */
  clearMessageQueue(instanceId: string): void {
    this.stateService.messageQueue.update((map) => {
      const newMap = new Map(map);
      newMap.delete(instanceId);
      return newMap;
    });
  }

  /**
   * Clear the message queue and restore the first message to the input draft.
   * Used when the instance enters a terminal state (failed/error/terminated).
   * Instead of silently dropping messages, the user's text is preserved in the
   * composer so they can re-send after restarting.
   */
  clearQueueWithNotification(instanceId: string): void {
    const queue = this.stateService.messageQueue().get(instanceId);
    if (!queue || queue.length === 0) return;

    const count = queue.length;

    // Restore the first queued message to the input draft so the user
    // doesn't lose their text. They can re-send after restarting.
    const firstMessage = queue[0];
    if (firstMessage?.message) {
      this.draftService.setDraft(instanceId, firstMessage.message);
    }

    this.clearMessageQueue(instanceId);

    if (count === 1) {
      this.addErrorToOutput(
        instanceId,
        'Your message was restored to the input — restart the instance to send it.'
      );
    } else {
      this.addErrorToOutput(
        instanceId,
        `Your message was restored to the input. ${count - 1} additional queued message${count > 1 ? 's were' : ' was'} discarded. Restart the instance to continue.`
      );
    }
  }

  /**
   * Remove a specific message from the queue and return it
   */
  removeFromQueue(
    instanceId: string,
    index: number
  ): QueuedMessage | null {
    const currentMap = this.stateService.messageQueue();
    const queue = currentMap.get(instanceId);
    if (!queue || index < 0 || index >= queue.length) return null;

    const removed = queue[index];

    this.stateService.messageQueue.update((map) => {
      const newMap = new Map(map);
      const currentQueue = newMap.get(instanceId) || [];
      const newQueue = [
        ...currentQueue.slice(0, index),
        ...currentQueue.slice(index + 1),
      ];
      if (newQueue.length === 0) {
        newMap.delete(instanceId);
      } else {
        newMap.set(instanceId, newQueue);
      }
      return newMap;
    });

    return removed;
  }

  // ============================================
  // Message Sending
  // ============================================

  /**
   * Send input to an instance (queues if busy)
   */
  async sendInput(
    instanceId: string,
    message: string,
    files?: File[]
  ): Promise<void> {
    const instance = this.stateService.getInstance(instanceId);
    if (!instance) return;

    // Clear recovery state on first user message — the user is re-establishing context
    if (instance.restoreMode) {
      this.stateService.updateInstance(instanceId, { restoreMode: undefined });
    }

    // Reject immediately if instance is in a terminal state — sending will fail
    // and the optimistic busy status would mask the real state from retry logic.
    if (isTerminalStatus(instance.status)) {
      console.warn('InstanceMessagingStore: Cannot send to instance in terminal state', {
        instanceId,
        status: instance.status,
      });
      this.addErrorToOutput(
        instanceId,
        `Cannot send message — instance is ${instance.status}. Try restarting the instance.`
      );
      return;
    }

    // If instance is busy, respawning, degraded, or in a transitional state, queue the message instead of sending immediately.
    // 'degraded' means the remote node is temporarily disconnected — queue so the
    // message can be delivered if/when the node reconnects and the instance is restored.
    if (
      isTransientQueueStatus(instance.status)
      || this.pauseStore.isPaused()
    ) {
      this.enqueueMessage(instanceId, { message, files });
      return;
    }

    // Send the message immediately
    await this.sendInputImmediate(instanceId, message, files);
  }

  /**
   * Steer the active turn with the user's latest message.
   *
   * Native same-turn steering is provider-specific. The cross-provider fallback
   * is to preserve the message at the front of the queue and request a single
   * interrupt; the normal queue drain then delivers it as soon as the provider
   * reaches a prompt again.
   */
  async steerInput(
    instanceId: string,
    message: string,
    files?: File[]
  ): Promise<void> {
    const instance = this.stateService.getInstance(instanceId);
    if (!instance) return;

    if (instance.restoreMode) {
      this.stateService.updateInstance(instanceId, { restoreMode: undefined });
    }

    if (isTerminalStatus(instance.status)) {
      console.warn('InstanceMessagingStore: Cannot steer instance in terminal state', {
        instanceId,
        status: instance.status,
      });
      this.addErrorToOutput(
        instanceId,
        `Cannot steer message — instance is ${instance.status}. Try restarting the instance.`
      );
      return;
    }

    if (isReadyForInputStatus(instance.status)) {
      if (this.pauseStore.isPaused()) {
        this.enqueueSteerMessage(instanceId, { message, files, kind: 'steer' });
        return;
      }
      await this.sendInputImmediate(instanceId, message, files);
      return;
    }

    this.enqueueSteerMessage(instanceId, { message, files, kind: 'steer' });

    await this.requestInterruptForSteer(instanceId, instance.status);
  }

  async steerQueuedMessage(instanceId: string, index: number): Promise<void> {
    const instance = this.stateService.getInstance(instanceId);
    if (!instance) return;

    if (instance.restoreMode) {
      this.stateService.updateInstance(instanceId, { restoreMode: undefined });
    }

    if (isTerminalStatus(instance.status)) {
      console.warn('InstanceMessagingStore: Cannot steer queued message for instance in terminal state', {
        instanceId,
        status: instance.status,
      });
      this.addErrorToOutput(
        instanceId,
        `Cannot steer queued message — instance is ${instance.status}. Try restarting the instance.`
      );
      return;
    }

    const queuedMessage = this.removeFromQueue(instanceId, index);
    if (!queuedMessage) return;

    const steerMessage: QueuedMessage = {
      ...queuedMessage,
      kind: 'steer',
    };

    if (isReadyForInputStatus(instance.status) && !this.pauseStore.isPaused()) {
      await this.sendInputImmediate(
        instanceId,
        steerMessage.message,
        steerMessage.files,
        steerMessage.retryCount ?? 0,
        {
          skipUserBubble: steerMessage.seededAlready === true,
          queuedMetadata: this.pickQueuedMetadata(steerMessage),
        }
      );
      return;
    }

    this.enqueueSteerMessage(instanceId, steerMessage);
    await this.requestInterruptForSteer(instanceId, instance.status);
  }

  private async requestInterruptForSteer(
    instanceId: string,
    status: InstanceStatus | undefined
  ): Promise<void> {
    if (!isActiveTurnStatus(status) || this.hasRecentInterruptRequest(instanceId)) {
      return;
    }

    this.noteInterruptRequested(instanceId);
    const interrupted = await this.listStore.interruptInstance(instanceId);
    if (!interrupted) {
      this.addErrorToOutput(
        instanceId,
        'Steer message queued, but the active turn did not accept an interrupt. It will send when the session is ready.'
      );
    }
  }

  /**
   * Record a user interrupt request so a follow-up steer submitted immediately
   * after Escape does not send a second interrupt and escalate cancellation.
   */
  noteInterruptRequested(instanceId: string): void {
    this.interruptRequests.set(instanceId, Date.now());
  }

  /**
   * Internal method to send input immediately (bypasses queue check)
   */
  async sendInputImmediate(
    instanceId: string,
    message: string,
    files?: File[],
    retryCount = 0,
    options: SendInputImmediateOptions = {}
  ): Promise<void> {
    const previousStatus = this.stateService.getInstance(instanceId)?.status;

    if (this.pauseStore.isPaused()) {
      this.enqueueMessageFront(instanceId, {
        message,
        files,
        retryCount,
        ...this.createQueuedMetadata(options),
      });
      return;
    }

    // Drop truly empty messages (no text AND no files)
    if (!message && (!files || files.length === 0)) {
      return;
    }

    // Validate files first
    if (files && files.length > 0) {
      const validationErrors = this.listStore.validateFiles(files);
      if (validationErrors.length > 0) {
        const errorMessage = validationErrors.join('\n');
        console.error('InstanceMessagingStore: File validation failed:', errorMessage);
        this.addErrorToOutput(instanceId, `Failed to send message:\n${errorMessage}`);
        return;
      }
    }

    // Convert files to base64 for IPC
    let attachments;
    try {
      attachments =
        files && files.length > 0
          ? (await Promise.all(files.map((f) => this.listStore.fileToAttachments(f)))).flat()
          : undefined;
    } catch (error) {
      console.error('InstanceMessagingStore: File conversion failed:', error);
      this.addErrorToOutput(
        instanceId,
        `Failed to process attachment: ${(error as Error).message}`
      );
      return;
    }

    // Optimistically update status (only if not already in a terminal state)
    if (previousStatus !== 'failed' && previousStatus !== 'error' && previousStatus !== 'terminated') {
      this.stateService.updateInstance(instanceId, {
        status: 'busy' as InstanceStatus,
      });
    }

    const result = await this.ipc.sendInput(
      instanceId,
      message,
      attachments,
      retryCount > 0 || options.skipUserBubble === true
    );

    // If send failed, decide whether to retry or drop
    if (!result.success) {
      console.error('InstanceMessagingStore: sendInput failed', result.error);

      const errorMessage = result.error?.message || 'Failed to send message';
      const currentInstance = this.stateService.getInstance(instanceId);
      // Use previousStatus to avoid the optimistic 'busy' masking the real state
      const effectiveStatus = previousStatus !== 'busy' ? previousStatus : currentInstance?.status;
      const retryDisposition = this.getRetryDisposition(effectiveStatus, errorMessage);

      if (!retryDisposition.shouldRetry) {
        // Permanent failure: revert optimistic 'busy' to previous status and show error
        if (currentInstance && currentInstance.status === 'busy') {
          this.stateService.updateInstance(instanceId, {
            status: retryDisposition.nextStatus ?? previousStatus ?? 'idle',
          });
        }
        this.addErrorToOutput(instanceId, `Failed to send message:\n${errorMessage}`);
        return;
      }

      const nextRetryCount = retryCount + 1;

      // Enforce retry limit to prevent infinite re-queue loops
      if (nextRetryCount > MAX_QUEUE_RETRIES) {
        console.error('InstanceMessagingStore: Max retries exceeded, dropping message', {
          instanceId,
          retryCount: nextRetryCount,
          errorMessage,
        });
        if (currentInstance && currentInstance.status === 'busy') {
          this.stateService.updateInstance(instanceId, {
            status: previousStatus ?? 'idle',
          });
        }
        this.addErrorToOutput(
          instanceId,
          `Failed to send message after ${MAX_QUEUE_RETRIES} retries:\n${errorMessage}`
        );
        return;
      }

      // Transient failure: revert optimistic status and re-queue for retry
      if (currentInstance && currentInstance.status === 'busy') {
        this.stateService.updateInstance(instanceId, {
          status: retryDisposition.nextStatus ?? previousStatus ?? 'idle',
        });
      }

      this.stateService.messageQueue.update((currentMap) => {
        const newMap = new Map(currentMap);
        const existingQueue = newMap.get(instanceId) || [];
        newMap.set(instanceId, [
          {
            message,
            files,
            retryCount: nextRetryCount,
            ...this.createQueuedMetadata(options),
          },
          ...existingQueue,
        ]);
        return newMap;
      });

      // Schedule a retry. The primary drain trigger is batch-update → idle,
      // but if we're already idle locally we need to re-trigger ourselves.
      const nextStatus = retryDisposition.nextStatus ?? previousStatus ?? 'idle';
      if (nextStatus === 'idle' || nextStatus === 'waiting_for_input') {
        setTimeout(() => {
          this.processMessageQueue(instanceId);
        }, 2000);
      }
    }
  }

  /**
   * Process queued messages for an instance
   * Called when instance becomes idle or waiting_for_input
   */
  processMessageQueue(instanceId: string): void {
    if (this.pauseStore.isPaused()) return;

    // Double-check the instance is actually ready to receive input.
    // This guards against premature queue drains from stale or
    // optimistic status updates (e.g., during respawning).
    const instance = this.stateService.getInstance(instanceId);
    if (!instance) return;
    if (instance.status !== 'idle' && instance.status !== 'ready' && instance.status !== 'waiting_for_input') {
      return;
    }

    const currentMap = this.stateService.messageQueue();
    const queue = currentMap.get(instanceId);
    if (!queue || queue.length === 0) return;

    // Take the first message from the queue
    const nextMessage = queue[0];
    const remainingQueue = queue.slice(1);

    // Update the signal with the new queue state
    this.stateService.messageQueue.update((map) => {
      const newMap = new Map(map);
      if (remainingQueue.length === 0) {
        newMap.delete(instanceId);
      } else {
        newMap.set(instanceId, remainingQueue);
      }
      return newMap;
    });

    if (nextMessage) {
      // Use setTimeout to avoid state update conflicts
      const retryCount = nextMessage.retryCount ?? 0;
      setTimeout(() => {
        this.sendInputImmediate(instanceId, nextMessage.message, nextMessage.files, retryCount, {
          skipUserBubble: nextMessage.seededAlready === true,
          queuedMetadata: this.pickQueuedMetadata(nextMessage),
        });
      }, 100);
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  private getRetryDisposition(
    status: InstanceStatus | undefined,
    errorMessage: string
  ): { shouldRetry: boolean; nextStatus?: InstanceStatus } {
    const normalized = errorMessage.toLowerCase();

    // Transient: instance is recovering from interrupt/respawn.
    if (
      isInterruptRecoveryStatus(status)
      || normalized.includes('respawning')
      || normalized.includes('interrupt recovery')
      || normalized.includes('recovering from interrupt')
    ) {
      return {
        shouldRetry: true,
        nextStatus: isInterruptRecoveryStatus(status) ? status : 'respawning',
      };
    }

    // Transient: instance is still initializing or waking
    if (status === 'initializing' || status === 'waking') {
      return { shouldRetry: true, nextStatus: status };
    }

    // Transient: CLI adapter not yet ready (common immediately after respawn)
    if (normalized.includes('not ready') || normalized.includes('not spawned')) {
      return { shouldRetry: true };
    }

    // Permanent: instance is in a fatal state
    if (status === 'error' || status === 'failed' || normalized.includes('error state') || normalized.includes('inconsistent state')) {
      return { shouldRetry: false, nextStatus: status === 'failed' ? 'failed' : 'error' };
    }

    if (status === 'terminated' || normalized.includes('terminated')) {
      return { shouldRetry: false, nextStatus: 'terminated' };
    }

    // Default: retry unknown errors — the watchdog and batch updates will
    // correct the status if the instance is actually in a permanent state.
    // This prevents message loss from transient post-respawn timing issues.
    return { shouldRetry: true };
  }

  private enqueueMessage(instanceId: string, queuedMessage: QueuedMessage): void {
    this.stateService.messageQueue.update((currentMap) => {
      const newMap = new Map(currentMap);
      const queue = newMap.get(instanceId) || [];
      newMap.set(instanceId, [...queue, queuedMessage]);
      return newMap;
    });
  }

  private enqueueMessageFront(instanceId: string, queuedMessage: QueuedMessage): void {
    this.stateService.messageQueue.update((currentMap) => {
      const newMap = new Map(currentMap);
      const queue = newMap.get(instanceId) || [];
      newMap.set(instanceId, [queuedMessage, ...queue]);
      return newMap;
    });
  }

  private enqueueSteerMessage(instanceId: string, queuedMessage: QueuedMessage): void {
    this.stateService.messageQueue.update((currentMap) => {
      const newMap = new Map(currentMap);
      const queue = newMap.get(instanceId) || [];
      const firstPassiveIndex = queue.findIndex((item) => item.kind !== 'steer');
      const insertAt = firstPassiveIndex === -1 ? queue.length : firstPassiveIndex;
      newMap.set(instanceId, [
        ...queue.slice(0, insertAt),
        queuedMessage,
        ...queue.slice(insertAt),
      ]);
      return newMap;
    });
  }

  private hasRecentInterruptRequest(instanceId: string): boolean {
    const requestedAt = this.interruptRequests.get(instanceId);
    if (requestedAt === undefined) return false;
    if (Date.now() - requestedAt <= InstanceMessagingStore.RECENT_INTERRUPT_MS) {
      return true;
    }
    this.interruptRequests.delete(instanceId);
    return false;
  }

  private createQueuedMetadata(
    options: SendInputImmediateOptions
  ): Pick<QueuedMessage, 'kind' | 'hadAttachmentsDropped' | 'seededAlready'> {
    const metadata: Pick<QueuedMessage, 'kind' | 'hadAttachmentsDropped' | 'seededAlready'> = {};

    if (options.queuedMetadata?.kind) {
      metadata.kind = options.queuedMetadata.kind;
    }
    if (options.queuedMetadata?.hadAttachmentsDropped === true) {
      metadata.hadAttachmentsDropped = true;
    }
    if (options.skipUserBubble === true || options.queuedMetadata?.seededAlready === true) {
      metadata.seededAlready = true;
    }

    return metadata;
  }

  private pickQueuedMetadata(
    message: QueuedMessage
  ): Pick<QueuedMessage, 'kind' | 'hadAttachmentsDropped' | 'seededAlready'> {
    const metadata: Pick<QueuedMessage, 'kind' | 'hadAttachmentsDropped' | 'seededAlready'> = {};

    if (message.kind) {
      metadata.kind = message.kind;
    }
    if (message.hadAttachmentsDropped === true) {
      metadata.hadAttachmentsDropped = true;
    }
    if (message.seededAlready === true) {
      metadata.seededAlready = true;
    }

    return metadata;
  }

  /**
   * Add an error message to the output buffer
   */
  private addErrorToOutput(instanceId: string, content: string): void {
    const instance = this.stateService.getInstance(instanceId);
    if (!instance) return;

    const errorOutput: OutputMessage = {
      id: `error-${Date.now()}`,
      timestamp: Date.now(),
      type: 'error',
      content,
    };

    this.stateService.updateInstance(instanceId, {
      outputBuffer: [...instance.outputBuffer, errorOutput],
    });
  }
}
