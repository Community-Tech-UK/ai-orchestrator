import type { Instance, InstanceStatus, QueuedMessage } from './instance.types';
import type { FileAttachment } from '../../../../../shared/types/instance.types';
import { validateAttachmentCount } from './instance-attachments';
import type { InstanceStateService } from './instance-state.service';

export interface SendInputImmediateOptions {
  skipUserBubble?: boolean;
  queuedMetadata?: Pick<QueuedMessage, 'kind' | 'hadAttachmentsDropped' | 'seededAlready'>;
}

/** Append to the back of an instance's queue. Extracted so InstanceMessagingStore stays under its LOC ratchet. */
export function enqueueToQueue(stateService: InstanceStateService, instanceId: string, queuedMessage: QueuedMessage): void {
  stateService.messageQueue.update((currentMap) => {
    const newMap = new Map(currentMap);
    const queue = newMap.get(instanceId) || [];
    newMap.set(instanceId, [...queue, queuedMessage]);
    return newMap;
  });
}

/** Prepend to the front of an instance's queue (pause-front-of-line, retry-requeue, terminal-restart). */
export function enqueueToQueueFront(stateService: InstanceStateService, instanceId: string, queuedMessage: QueuedMessage): void {
  stateService.messageQueue.update((currentMap) => {
    const newMap = new Map(currentMap);
    const queue = newMap.get(instanceId) || [];
    newMap.set(instanceId, [queuedMessage, ...queue]);
    return newMap;
  });
}

/** Insert after any existing steer messages but before the first passive-queue message. */
export function enqueueSteerToQueue(stateService: InstanceStateService, instanceId: string, queuedMessage: QueuedMessage): void {
  stateService.messageQueue.update((currentMap) => {
    const newMap = new Map(currentMap);
    const queue = newMap.get(instanceId) || [];
    const firstPassiveIndex = queue.findIndex((item) => item.kind !== 'steer');
    const insertAt = firstPassiveIndex === -1 ? queue.length : firstPassiveIndex;
    newMap.set(instanceId, [...queue.slice(0, insertAt), queuedMessage, ...queue.slice(insertAt)]);
    return newMap;
  });
}

/**
 * Remove one specific entry by object reference (not index — the queue may
 * have been reordered/mutated during an await since the caller captured it).
 * Returns false when the entry is no longer present (already cancelled/sent
 * by another path), which callers use to avoid a duplicate send.
 */
export function removeQueuedEntry(stateService: InstanceStateService, instanceId: string, entry: QueuedMessage): boolean {
  let removed = false;
  stateService.messageQueue.update((currentMap) => {
    const queue = currentMap.get(instanceId);
    if (!queue) return currentMap;
    const index = queue.indexOf(entry);
    if (index === -1) return currentMap;
    removed = true;
    const newMap = new Map(currentMap);
    const newQueue = [...queue.slice(0, index), ...queue.slice(index + 1)];
    if (newQueue.length === 0) newMap.delete(instanceId); else newMap.set(instanceId, newQueue);
    return newMap;
  });
  return removed;
}

export function isTransientQueueStatus(status: InstanceStatus): boolean {
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

export function isActiveTurnStatus(status: InstanceStatus | undefined): boolean {
  return status === 'busy'
    || status === 'processing'
    || status === 'thinking_deeply'
    || status === 'waiting_for_permission';
}

export function isInterruptRecoveryStatus(status: InstanceStatus | undefined): boolean {
  return status === 'respawning'
    || status === 'interrupting'
    || status === 'cancelling'
    || status === 'interrupt-escalating';
}

export function isReadyForInputStatus(status: InstanceStatus | undefined): boolean {
  return status === 'idle'
    || status === 'ready'
    || status === 'waiting_for_input';
}

/**
 * An idle instance parked on a provider quota window (auto-resume opt-in —
 * see `instanceProviderLimitResumeEnabled`). Main resends the throttled turn
 * itself once the window resets, so the renderer must not race it by draining
 * or sending into the parked instance in the meantime.
 */
export function isQuotaParked(instance: Pick<Instance, 'waitReason'> | undefined): boolean {
  return instance?.waitReason?.kind === 'quota-park';
}

export function isTerminalStatus(status: InstanceStatus | undefined): boolean {
  return status === 'failed'
    || status === 'error'
    || status === 'terminated'
    || status === 'cancelled'
    || status === 'superseded';
}

export function createQueuedMetadata(
  options: SendInputImmediateOptions,
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

export function pickQueuedMetadata(
  message: QueuedMessage,
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

export interface FileAttachmentAdapter {
  validateFiles(files: File[]): string[];
  fileToAttachments(file: File): Promise<FileAttachment[]>;
}

export async function inputFilesToAttachments(
  instanceId: string,
  files: File[],
  action: 'send' | 'steer',
  adapter: FileAttachmentAdapter,
  addErrorToOutput: (instanceId: string, message: string) => void,
): Promise<FileAttachment[] | null> {
  const validationErrors = adapter.validateFiles(files);
  if (validationErrors.length > 0) {
    const errorMessage = validationErrors.join('\n');
    console.error('InstanceMessagingStore: File validation failed:', errorMessage);
    addErrorToOutput(instanceId, `Failed to ${action} message:\n${errorMessage}`);
    return null;
  }

  try {
    const attachments = (await Promise.all(files.map((f) => adapter.fileToAttachments(f)))).flat();

    // Large images are tiled, so the staged file count is not the payload
    // count. Past the main-process cap the whole payload is rejected by Zod
    // with nothing logged, which looks to the user like the send vanished.
    const countError = validateAttachmentCount(attachments, files.length);
    if (countError) {
      addErrorToOutput(instanceId, `Failed to ${action} message:\n${countError}`);
      return null;
    }

    return attachments;
  } catch (error) {
    console.error('InstanceMessagingStore: File conversion failed:', error);
    addErrorToOutput(
      instanceId,
      `Failed to process attachment: ${(error as Error).message}`
    );
    return null;
  }
}
