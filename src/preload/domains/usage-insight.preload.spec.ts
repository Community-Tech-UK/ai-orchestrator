import { expect, it, vi } from 'vitest';
import { createDiagnosticsDomain } from './diagnostics.preload';
import { IPC_CHANNELS } from '../generated/channels';

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
