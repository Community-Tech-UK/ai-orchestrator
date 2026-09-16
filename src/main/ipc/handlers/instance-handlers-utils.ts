/**
 * Shared helpers for the instance IPC handlers.
 */
import type { z } from 'zod';
import { getSettingsManager } from '../../core/config/settings-manager';
import type { FileAttachment, InstanceProvider } from '../../../shared/types/instance.types';
import { FileAttachmentSchema } from '@contracts/schemas/common';
import { InstanceCreatePayloadSchema } from '@contracts/schemas/instance';

export type FileAttachmentPayload = z.infer<typeof FileAttachmentSchema>;
export type InstanceCreateProvider = z.infer<typeof InstanceCreatePayloadSchema>['provider'];

/**
 * Map the IPC attachment schema onto the runtime FileAttachment type.
 * The schema allows omitted `data`; instance runtime requires a string.
 */
export function toFileAttachments(
  attachments: FileAttachmentPayload[] | undefined,
): FileAttachment[] | undefined {
  if (!attachments) {
    return undefined;
  }
  return attachments.map((attachment) => ({
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    data: attachment.data ?? '',
  }));
}

/**
 * `auto` means "let routing pick"; that is not a concrete InstanceProvider.
 */
export function toInstanceProvider(
  provider: InstanceCreateProvider,
): InstanceProvider | undefined {
  if (!provider || provider === 'auto') {
    return undefined;
  }
  return provider;
}

/**
 * Resolve the working directory for a new instance: an explicit non-'.' path
 * wins, otherwise fall back to the configured default working directory, then to
 * the process cwd. Shared by INSTANCE_CREATE and INSTANCE_CREATE_WITH_MESSAGE.
 */
export function resolveDefaultWorkingDirectory(workingDirectory: string | undefined): string {
  if (workingDirectory && workingDirectory !== '.') {
    return workingDirectory;
  }
  const defaultDir = getSettingsManager().get('defaultWorkingDirectory');
  return defaultDir || process.cwd();
}
