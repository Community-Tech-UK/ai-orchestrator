import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { createDiagnosticsDomain } from './diagnostics.preload';
import { IPC_CHANNELS } from '../generated/channels';

describe('retrieved-context delivery subscription', () => {
  it('forwards only its dedicated event and removes the same listener on teardown', () => {
    const on = vi.fn(); const removeListener = vi.fn();
    const api = createDiagnosticsDomain({ on, removeListener } as unknown as IpcRenderer, IPC_CHANNELS);
    const callback = vi.fn(); const stop = api.onInputContextDelivered(callback);
    const [channel, listener] = on.mock.calls[0] as [string, (event: unknown, payload: unknown) => void];
    const delivery = { instanceId: 'session', messageId: 'user', deliveryId: 'delivery', tokens: null };
    expect(channel).toBe(IPC_CHANNELS.INSTANCE_INPUT_CONTEXT_DELIVERED);
    listener({}, delivery); expect(callback).toHaveBeenCalledWith(delivery);
    stop(); expect(removeListener).toHaveBeenCalledWith(channel, listener);
  });
});

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

it('asks for the usage breakdown with only the fields the main process accepts', async () => {
  const invoke = vi.fn(async () => ({ success: true }));
  const api = createDiagnosticsDomain({ invoke } as never, IPC_CHANNELS);
  await api.usageInsightGet();
  await api.usageInsightGet({ instanceId: 'inst-1', refresh: true });
  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.USAGE_INSIGHT_GET, {}],
    [IPC_CHANNELS.USAGE_INSIGHT_GET, { instanceId: 'inst-1', refresh: true }],
  ]);
});
