/**
 * Instance Output Store - Manages output buffering and throttling
 *
 * Handles high-frequency output messages with throttling to prevent UI thrashing.
 */

import { Injectable, inject, NgZone } from '@angular/core';
import { InstanceStateService } from './instance-state.service';
import type { OutputMessage } from './instance.types';
import type {
  FailedImageRef,
  FileAttachment,
} from '../../../../../shared/types/instance.types';
import { LIMITS } from '../../../../../shared/constants/limits';
import { ImageAttachmentService, type ImageAttachmentSink } from '../../../features/instance-detail/image-attachment.service';

function getAccumulatedStreamingContent(message: OutputMessage): string {
  const accumulated = message.metadata?.['accumulatedContent'];
  return typeof accumulated === 'string' ? accumulated : message.content;
}

@Injectable({ providedIn: 'root' })
export class InstanceOutputStore implements ImageAttachmentSink {
  private stateService = inject(InstanceStateService);
  private ngZone = inject(NgZone);
  private imageAttachmentService = inject(ImageAttachmentService);

  // ============================================
  // Output Throttling
  // ============================================

  /**
   * Queue output message with throttling (100ms batches)
   */
  queueOutput(instanceId: string, message: OutputMessage): void {
    // Filter out empty messages (defense-in-depth)
    if (!this.hasContent(message)) {
      console.warn(
        `[InstanceOutputStore] Dropped empty ${message.type} message for instance ${instanceId}`,
        { id: message.id, contentLength: message.content?.length ?? 0 }
      );
      return;
    }

    const { outputThrottleTimers, pendingOutputMessages } = this.stateService;

    // Add to pending messages
    const pending = pendingOutputMessages.get(instanceId) || [];
    pending.push(message);
    pendingOutputMessages.set(instanceId, pending);

    // If no timer exists, start one
    if (!outputThrottleTimers.has(instanceId)) {
      const timer = setTimeout(() => {
        // Run inside NgZone to trigger Angular change detection
        this.ngZone.run(() => {
          this.flushOutput(instanceId, false);
        });
      }, LIMITS.TEXT_THROTTLE_MS);
      outputThrottleTimers.set(instanceId, timer);
    }
  }

  /**
   * Flush pending output messages for an instance
   * Handles streaming messages by updating existing messages with the same ID
   */
  flushOutput(instanceId: string, finalizeStreaming: boolean): void {
    const { outputThrottleTimers, pendingOutputMessages } = this.stateService;
    const pending = pendingOutputMessages.get(instanceId);
    if (!pending || pending.length === 0) return;

    // Clear timer and pending
    outputThrottleTimers.delete(instanceId);
    pendingOutputMessages.delete(instanceId);
    const candidateMessageIds = new Set<string>();

    // Apply all pending messages at once
    this.stateService.state.update((current) => {
      const newMap = new Map(current.instances);
      const instance = newMap.get(instanceId);

      if (instance) {
        // Start with existing messages
        const outputBuffer: OutputMessage[] = [...instance.outputBuffer];

        // Process each pending message
        for (const msg of pending) {
          if (msg.type === 'assistant') {
            candidateMessageIds.add(msg.id);
          }
          const streamingState = msg.metadata && 'streaming' in msg.metadata
            ? msg.metadata['streaming']
            : undefined;

          if (streamingState === true || streamingState === false) {
            // For streaming messages, update existing or add new
            const existingIdx = outputBuffer.findIndex((m) => m.id === msg.id);
            if (existingIdx >= 0) {
              // Update existing message with accumulated content
              const accumulatedContent = getAccumulatedStreamingContent(msg);
              outputBuffer[existingIdx] = {
                ...outputBuffer[existingIdx],
                content: accumulatedContent,
                metadata: msg.metadata,
                thinking: msg.thinking ?? outputBuffer[existingIdx].thinking,
                thinkingExtracted: msg.thinkingExtracted ?? outputBuffer[existingIdx].thinkingExtracted,
              };
            } else {
              // First chunk of this streaming message
              outputBuffer.push({
                ...msg,
                content: getAccumulatedStreamingContent(msg),
              });
            }
          } else {
            // Regular message - just append
            outputBuffer.push(msg);
          }
        }

        // Keep buffer trimmed
        const trimmed =
          outputBuffer.length > 1000 ? outputBuffer.slice(-1000) : outputBuffer;

        newMap.set(instanceId, {
          ...instance,
          outputBuffer: trimmed,
          lastActivity: Date.now(),
        });
      }

      return { ...current, instances: newMap };
    });

    this.processResolvedImages(instanceId, candidateMessageIds, finalizeStreaming);
  }

  /**
   * Force flush output for an instance (call on completion)
   */
  flushInstanceOutput(instanceId: string): void {
    const timer = this.stateService.outputThrottleTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.stateService.outputThrottleTimers.delete(instanceId);
    }
    this.flushOutput(instanceId, true);
    this.processAllUnresolvedAssistantMessages(instanceId);
  }

  /**
   * Prepend older messages loaded from disk storage to the front of the buffer.
   * Used by scroll-to-load-more to show conversation history.
   */
  prependOlderMessages(instanceId: string, olderMessages: OutputMessage[]): void {
    if (olderMessages.length === 0) return;
    let uniqueOlder: OutputMessage[] = [];

    this.stateService.state.update((current) => {
      const newMap = new Map(current.instances);
      const instance = newMap.get(instanceId);

      if (instance) {
        // Deduplicate: filter out any messages that already exist in the current buffer
        const existingIds = new Set(instance.outputBuffer.map(m => m.id));
        uniqueOlder = olderMessages.filter(m => !existingIds.has(m.id));

        if (uniqueOlder.length > 0) {
          newMap.set(instanceId, {
            ...instance,
            outputBuffer: [...uniqueOlder, ...instance.outputBuffer],
          });
        }
      }

      return { ...current, instances: newMap };
    });

    const candidateMessageIds = new Set(
      uniqueOlder
        .filter((message) => message.type === 'assistant')
        .map((message) => message.id),
    );
    this.processResolvedImages(instanceId, candidateMessageIds, true);
  }

  appendAttachmentsToMessage(
    instanceId: string,
    messageId: string,
    attachments: FileAttachment[],
    failedImages: FailedImageRef[],
  ): void {
    if (attachments.length === 0 && failedImages.length === 0) {
      return;
    }

    this.stateService.state.update((current) => {
      const instances = new Map(current.instances);
      const instance = instances.get(instanceId);
      if (!instance) {
        return current;
      }

      const outputBuffer = instance.outputBuffer.map((message) => {
        if (message.id !== messageId) {
          return message;
        }

        const existingAttachmentKeys = new Set(
          (message.attachments ?? []).map((attachment) => `${attachment.name}:${attachment.data}`),
        );
        const mergedAttachments = [
          ...(message.attachments ?? []),
          ...attachments.filter((attachment) => {
            const key = `${attachment.name}:${attachment.data}`;
            if (existingAttachmentKeys.has(key)) {
              return false;
            }
            existingAttachmentKeys.add(key);
            return true;
          }),
        ];

        const existingFailureKeys = new Set(
          (message.failedImages ?? []).map((failure) => `${failure.kind}:${failure.src}:${failure.reason}`),
        );
        const mergedFailures = [
          ...(message.failedImages ?? []),
          ...failedImages.filter((failure) => {
            const key = `${failure.kind}:${failure.src}:${failure.reason}`;
            if (existingFailureKeys.has(key)) {
              return false;
            }
            existingFailureKeys.add(key);
            return true;
          }),
        ];

        return {
          ...message,
          attachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
          failedImages: mergedFailures.length > 0 ? mergedFailures : undefined,
        };
      });

      instances.set(instanceId, {
        ...instance,
        outputBuffer,
      });

      return { ...current, instances };
    });
  }

  markImagesResolved(instanceId: string, messageId: string): void {
    this.stateService.state.update((current) => {
      const instances = new Map(current.instances);
      const instance = instances.get(instanceId);
      if (!instance) {
        return current;
      }

      const outputBuffer = instance.outputBuffer.map((message) =>
        message.id === messageId
          ? {
              ...message,
              metadata: {
                ...(message.metadata ?? {}),
                imagesResolved: true,
              },
            }
          : message
      );

      instances.set(instanceId, {
        ...instance,
        outputBuffer,
      });

      return { ...current, instances };
    });
  }

  /**
   * Clean up timers for an instance (call on remove/destroy)
   */
  cleanupInstance(instanceId: string): void {
    const timer = this.stateService.outputThrottleTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.stateService.outputThrottleTimers.delete(instanceId);
    }
    this.stateService.pendingOutputMessages.delete(instanceId);
  }

  /**
   * Clean up all timers (call on destroy)
   */
  cleanupAll(): void {
    for (const timer of this.stateService.outputThrottleTimers.values()) {
      clearTimeout(timer);
    }
    this.stateService.outputThrottleTimers.clear();
    this.stateService.pendingOutputMessages.clear();
  }

  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Check if a message has meaningful content to display
   */
  private hasContent(message: OutputMessage): boolean {
    // Tool messages can have metadata as their primary content
    if (message.type === 'tool_use' || message.type === 'tool_result') {
      return !!message.metadata || !!message.content;
    }
    // Messages with attachments are valid even without text
    if (message.attachments && message.attachments.length > 0) {
      return true;
    }
    // Messages with failed inline-image resolutions are still meaningful to render
    if (message.failedImages && message.failedImages.length > 0) {
      return true;
    }
    // Messages with thinking content are valid even without text response
    if (message.thinking && message.thinking.length > 0) {
      return true;
    }
    const accumulatedContent = message.metadata?.['accumulatedContent'];
    if (typeof accumulatedContent === 'string' && accumulatedContent.trim()) {
      return true;
    }
    // For all other messages, check for non-empty content
    return !!message.content?.trim();
  }

  private processResolvedImages(
    instanceId: string,
    candidateMessageIds: Set<string>,
    finalized: boolean,
  ): void {
    if (candidateMessageIds.size === 0) {
      return;
    }

    const instance = this.stateService.getInstance(instanceId);
    if (!instance) {
      return;
    }

    for (const messageId of candidateMessageIds) {
      const message = instance.outputBuffer.find((item) => item.id === messageId);
      if (!message || message.type !== 'assistant') {
        continue;
      }

      void this.imageAttachmentService.processMessage(instanceId, message, this, {
        finalized,
      });
    }
  }

  private processAllUnresolvedAssistantMessages(instanceId: string): void {
    const instance = this.stateService.getInstance(instanceId);
    if (!instance) {
      return;
    }

    for (const message of instance.outputBuffer) {
      if (message.type !== 'assistant' || message.metadata?.['imagesResolved'] === true) {
        continue;
      }

      void this.imageAttachmentService.processMessage(instanceId, message, this, {
        finalized: true,
      });
    }
  }
}
