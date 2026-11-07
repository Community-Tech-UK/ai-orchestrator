import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { InstanceManager } from '../../instance/instance-manager';
import type { WindowManager } from '../../window-manager';
import { registerInstanceHandlers } from './instance-handlers';

const handlers = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => Promise<{ success: boolean }>>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<{ success: boolean }>) => handlers.set(channel, handler) } }));
vi.mock('./instance-close-all', () => ({ prepareUserClose: vi.fn(async () => undefined) }));
vi.mock('./instance-computer-use-handler', () => ({ registerInstanceComputerUseHandler: vi.fn() }));
vi.mock('./instance-compaction-handlers', () => ({ registerInstanceCompactionHandlers: vi.fn() }));
vi.mock('./instance-cross-session-messaging-handlers', () => ({ registerInstanceCrossSessionMessagingHandlers: vi.fn() }));
vi.mock('./instance-provider-limit-ipc', () => ({ registerInstanceProviderLimitHandlers: vi.fn() }));

describe('explicit child policy at the desktop termination boundary', () => {
  const terminateInstance = vi.fn(async () => undefined);
  beforeEach(() => {
    handlers.clear(); terminateInstance.mockClear();
    registerInstanceHandlers({ instanceManager: { terminateInstance } as unknown as InstanceManager,
      windowManager: {} as WindowManager });
  });

  it('forwards the keep-helpers choice after Zod validation', async () => {
    const response = await handlers.get(IPC_CHANNELS.INSTANCE_TERMINATE)!(null,
      { instanceId: 'parent', childPolicy: 'orphan-children' });
    expect(response.success).toBe(true);
    expect(terminateInstance).toHaveBeenCalledWith('parent', true, { childPolicy: 'orphan-children' });
  });

  it('rejects an invalid policy before termination', async () => {
    const response = await handlers.get(IPC_CHANNELS.INSTANCE_TERMINATE)!(null,
      { instanceId: 'parent', childPolicy: 'invalid-policy' });
    expect(response.success).toBe(false);
    expect(terminateInstance).not.toHaveBeenCalled();
  });
});
