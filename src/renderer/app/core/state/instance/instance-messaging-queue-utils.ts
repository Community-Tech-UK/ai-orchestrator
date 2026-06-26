import type { InstanceStatus, QueuedMessage } from './instance.types';
import type { FileAttachment } from '../../../../../shared/types/instance.types';

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
    return (await Promise.all(files.map((f) => adapter.fileToAttachments(f)))).flat();
  } catch (error) {
    console.error('InstanceMessagingStore: File conversion failed:', error);
    addErrorToOutput(
      instanceId,
      `Failed to process attachment: ${(error as Error).message}`
    );
    return null;
  }
}
