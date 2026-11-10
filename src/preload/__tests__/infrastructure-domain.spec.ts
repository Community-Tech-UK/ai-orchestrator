import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { INFRASTRUCTURE_CHANNELS } from '@contracts/channels';
import { IPC_CHANNELS } from '../generated/channels';
import { createInfrastructureDomain } from '../domains/infrastructure.preload';

describe('infrastructure preload domain', () => {
  it('wraps a single settings key in the validated SETTINGS_GET payload', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true, data: 'trusted' }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createInfrastructureDomain(ipcRenderer, IPC_CHANNELS);

    await domain.getSetting('computerUseAutonomyLevel');

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.SETTINGS_GET,
      { key: 'computerUseAutonomyLevel' },
    );
  });

  it('exposes stateResync for the renderer generic invoke mapping', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true, data: { seq: 1 } }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createInfrastructureDomain(ipcRenderer, IPC_CHANNELS);

    await domain.stateResync();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.STATE_RESYNC,
      { ipcAuthToken: undefined },
    );
  });

  // Regression: the domain is spread flat onto `electronAPI` (preload.ts), but
  // RendererHeartbeatService once read it from a non-existent `.infrastructure`
  // namespace, so `start()` silently no-opped and the app never sent a beat —
  // its own unit test mocked the same wrong shape and stayed green. Pin the key
  // at the level the renderer actually reads it from.
  it('exposes rendererHeartbeat at the top level, as a fire-and-forget send', () => {
    const ipcRenderer = {
      invoke: vi.fn(),
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createInfrastructureDomain(ipcRenderer, IPC_CHANNELS);

    expect(typeof domain.rendererHeartbeat).toBe('function');
    domain.rendererHeartbeat({ seq: 7, sentAt: 1234 });

    expect(ipcRenderer.send).toHaveBeenCalledWith(
      IPC_CHANNELS.RENDERER_HEARTBEAT,
      { seq: 7, sentAt: 1234 },
    );
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('passes codebase index status target through to the main process', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createInfrastructureDomain(ipcRenderer, IPC_CHANNELS);

    await domain.codebaseIndexStatus('/repo', 'legacy');

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.CODEBASE_INDEX_STATUS,
      { workspacePath: '/repo', target: 'legacy' },
    );
  });
});

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
