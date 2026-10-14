import { expect, it, vi } from 'vitest';
import { createDiagnosticsDomain } from './diagnostics.preload';
import { IPC_CHANNELS } from '../generated/channels';
it('forwards typed storage preview tickets without renderer-controlled paths', async () => {
  const invoke = vi.fn(async () => ({ success: true }));
  const api = createDiagnosticsDomain({ invoke } as never, IPC_CHANNELS);
  await api.storageGetUsage(true);
  await api.storagePreviewCleanup('rlm-backups');
  await api.storageRunCleanup('rlm-backups', 'fixture-ticket');
  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.STORAGE_GET_USAGE, { force: true }],
    [IPC_CHANNELS.STORAGE_PREVIEW_CLEANUP, { target: 'rlm-backups' }],
    [IPC_CHANNELS.STORAGE_RUN_CLEANUP, { target: 'rlm-backups', previewId: 'fixture-ticket' }],
  ]);
});
