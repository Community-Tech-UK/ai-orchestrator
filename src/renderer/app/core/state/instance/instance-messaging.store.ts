/**
 * Instance Messaging Store - Manages message queue and sending
 *
 * Handles message queuing when instance is busy and message sending.
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService } from '../../services/ipc';
import { InstanceStateService } from './instance-state.service';
import { InstanceListStore } from './instance-list.store';
import type { InstanceStatus, OutputMessage } from './instance.types';

@Injectable({ providedIn: 'root' })
export class InstanceMessagingStore {
  private stateService = inject(InstanceStateService);
  private ipc = inject(ElectronIpcService);
  private listStore = inject(InstanceListStore);
  private queueWatchdog: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Watchdog: periodically check for stuck queue items.
    // The primary drain trigger is applyBatchUpdates on idle transitions,
    // but timing/batching edge cases can leave messages stuck. This catches them.
    this.queueWatchdog = setInterval(() => this.drainAllReadyQueues(), 2000);
  }

  /**
   * Process queued messages for all instances that are currently idle.
   * Acts as a safety net for cases where the primary drain trigger misses.
   */
  private drainAllReadyQueues(): void {
    const queueMap = this.stateService.messageQueue();
    if (queueMap.size === 0) return;

    for (const [instanceId] of queueMap) {
      const instance = this.stateService.getInstance(instanceId);
      if (instance && (instance.status === 'idle' || instance.status === 'ready' || instance.status === 'waiting_for_input')) {
        console.log('InstanceMessagingStore: Watchdog draining stuck queue', { instanceId, status: instance.status });
        this.processMessageQueue(instanceId);
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
  getMessageQueue(instanceId: string): { message: string; files?: File[] }[] {
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
   * Remove a specific message from the queue and return it
   */
  removeFromQueue(
    instanceId: string,
    index: number
  ): { message: string; files?: File[] } | null {
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
    console.log('InstanceMessagingStore: sendInput called', {
      instanceId,
      message,
      filesCount: files?.length,
    });

    const instance = this.stateService.getInstance(instanceId);
    if (!instance) return;

    // Clear recovery state on first user message — the user is re-establishing context
    if (instance.restoreMode) {
      this.stateService.updateInstance(instanceId, { restoreMode: undefined });
    }

    // If instance is busy, respawning, or in a transitional state, queue the message instead of sending immediately
    if (
      instance.status === 'busy' ||
      instance.status === 'respawning' ||
      instance.status === 'initializing' ||
      instance.status === 'waking' ||
      instance.status === 'hibernating'
    ) {
      console.log('InstanceMessagingStore: Instance not ready, queuing message', {
        instanceId,
        status: instance.status,
      });
      this.stateService.messageQueue.update((currentMap) => {
        const newMap = new Map(currentMap);
        const queue = newMap.get(instanceId) || [];
        queue.push({ message, files });
        newMap.set(instanceId, queue);
        return newMap;
      });
      return;
    }

    // Send the message immediately
    await this.sendInputImmediate(instanceId, message, files);
  }

  /**
   * Internal method to send input immediately (bypasses queue check)
   */
  async sendInputImmediate(
    instanceId: string,
    message: string,
    files?: File[]
  ): Promise<void> {
    const previousStatus = this.stateService.getInstance(instanceId)?.status;

    // Drop truly empty messages (no text AND no files)
    if (!message && (!files || files.length === 0)) {
      console.log('InstanceMessagingStore: Dropping empty message (no text, no files)', { instanceId });
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

    // Optimistically update status
    this.stateService.updateInstance(instanceId, {
      status: 'busy' as InstanceStatus,
    });

    const result = await this.ipc.sendInput(instanceId, message, attachments);
    console.log('InstanceMessagingStore: sendInput result', result);

    // If send failed, decide whether to retry or drop
    if (!result.success) {
      console.error('InstanceMessagingStore: sendInput failed', result.error);

      const errorMessage = result.error?.message || 'Failed to send message';
      const currentInstance = this.stateService.getInstance(instanceId);
      const retryDisposition = this.getRetryDisposition(currentInstance?.status, errorMessage);

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

      // Transient failure: revert optimistic status and re-queue for retry
      if (currentInstance && currentInstance.status === 'busy') {
        this.stateService.updateInstance(instanceId, {
          status: retryDisposition.nextStatus ?? previousStatus ?? 'idle',
        });
      }

      console.log('InstanceMessagingStore: Re-queuing failed message at front of queue', {
        instanceId,
        errorMessage,
      });
      this.stateService.messageQueue.update((currentMap) => {
        const newMap = new Map(currentMap);
        const existingQueue = newMap.get(instanceId) || [];
        newMap.set(instanceId, [{ message, files }, ...existingQueue]);
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
    // Double-check the instance is actually ready to receive input.
    // This guards against premature queue drains from stale or
    // optimistic status updates (e.g., during respawning).
    const instance = this.stateService.getInstance(instanceId);
    if (!instance) return;
    if (instance.status !== 'idle' && instance.status !== 'ready' && instance.status !== 'waiting_for_input') {
      console.log('InstanceMessagingStore: Skipping queue processing, instance not ready', {
        instanceId,
        status: instance.status,
      });
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
      console.log('InstanceMessagingStore: Processing queued message', {
        instanceId,
        queueRemaining: remainingQueue.length,
      });
      // Use setTimeout to avoid state update conflicts
      setTimeout(() => {
        this.sendInputImmediate(instanceId, nextMessage.message, nextMessage.files);
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

    // Transient: instance is respawning after interrupt
    if (status === 'respawning' || normalized.includes('respawning')) {
      return { shouldRetry: true, nextStatus: 'respawning' };
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
    if (status === 'error' || normalized.includes('error state') || normalized.includes('inconsistent state')) {
      return { shouldRetry: false, nextStatus: 'error' };
    }

    if (status === 'terminated' || normalized.includes('terminated')) {
      return { shouldRetry: false, nextStatus: 'terminated' };
    }

    // Default: retry unknown errors — the watchdog and batch updates will
    // correct the status if the instance is actually in a permanent state.
    // This prevents message loss from transient post-respawn timing issues.
    return { shouldRetry: true };
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
