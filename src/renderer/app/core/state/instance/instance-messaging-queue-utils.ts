import type { InstanceStatus, QueuedMessage } from './instance.types';

export interface SendInputImmediateOptions {
  skipUserBubble?: boolean;
  queuedMetadata?: Pick<QueuedMessage, 'kind' | 'hadAttachmentsDropped' | 'seededAlready'>;
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
