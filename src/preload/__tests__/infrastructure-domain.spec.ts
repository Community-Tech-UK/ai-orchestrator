import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import { createInfrastructureDomain } from '../domains/infrastructure.preload';

describe('infrastructure preload domain', () => {
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
