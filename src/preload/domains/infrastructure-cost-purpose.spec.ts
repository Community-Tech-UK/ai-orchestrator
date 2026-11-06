import type { IpcRenderer } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { INFRASTRUCTURE_CHANNELS } from '@contracts/channels';
import { IPC_CHANNELS } from '../generated/channels';
import { createInfrastructureDomain } from './infrastructure.preload';

describe('cost purpose preload bridge', () => {
  it('passes an optional read-only range over the purpose summary channel', async () => {
    const ipcRenderer = { invoke: vi.fn().mockResolvedValue({ success: true, data: { byPurpose: [] } }) } as unknown as IpcRenderer;
    // The controller regenerates the channel snapshot after helper integration.
    const channels = { ...IPC_CHANNELS, COST_GET_PURPOSE_SUMMARY: INFRASTRUCTURE_CHANNELS.COST_GET_PURPOSE_SUMMARY };
    const domain = createInfrastructureDomain(ipcRenderer, channels);
    const range = { startTime: 10, endTime: 20 };
    await domain.costGetPurposeSummary(range);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('cost:get-purpose-summary', range);
  });
});
