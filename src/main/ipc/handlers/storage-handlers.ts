import { IPC_CHANNELS } from '@contracts/channels';
import { StorageUsageRequestSchema, StoragePreviewCleanupRequestSchema, StorageRunCleanupRequestSchema } from '@contracts/schemas/storage';
import { registerValidatedIpcHandler, type EnsureTrustedSender } from '../validated-handler';
import { createStorageRuntime, type StorageRuntime } from '../../storage/storage-runtime';

export function registerStorageHandlers(deps: { runtime?: StorageRuntime; getLiveIds?: () => ReadonlySet<string>; ensureTrustedSender?: EnsureTrustedSender } = {}): void {
  const runtime = deps.runtime ?? createStorageRuntime(deps.getLiveIds ?? (() => new Set()));
  const options = { ensureTrustedSender: deps.ensureTrustedSender };
  registerValidatedIpcHandler(IPC_CHANNELS.STORAGE_GET_USAGE, StorageUsageRequestSchema,
    async payload => ({ success: true, data: await runtime.usage.getUsage(payload.force) }), options);
  registerValidatedIpcHandler(IPC_CHANNELS.STORAGE_PREVIEW_CLEANUP, StoragePreviewCleanupRequestSchema,
    async payload => ({ success: true, data: await runtime.cleanup.preview(payload.target) }), options);
  registerValidatedIpcHandler(IPC_CHANNELS.STORAGE_RUN_CLEANUP, StorageRunCleanupRequestSchema,
    async payload => {
      const result = await runtime.cleanup.run(payload.target, payload.previewId);
      runtime.usage.invalidate();
      return { success: true, data: result };
    }, options);
}
