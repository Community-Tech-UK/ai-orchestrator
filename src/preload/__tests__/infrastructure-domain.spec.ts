import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import { createInfrastructureDomain } from '../domains/infrastructure.preload';

describe('infrastructure preload domain', () => {
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
