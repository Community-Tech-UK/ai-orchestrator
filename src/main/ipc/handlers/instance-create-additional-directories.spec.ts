import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../../instance/instance-manager';
import type { WindowManager } from '../../window-manager';
import { createInstanceDomain } from '../../../preload/domains/instance.preload';
import type { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ success: boolean }>>();
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<{ success: boolean }>) => handlers.set(channel, handler) }, app: { getPath: () => '/tmp/test' } }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => undefined, getAll: () => ({}) }) }));
vi.mock('../../commands/command-manager', () => ({ getCommandManager: () => ({ getCommands: () => [] }), CommandManager: vi.fn() }));
vi.mock('./instance-provider-limit-ipc', () => ({ registerInstanceProviderLimitHandlers: () => undefined }));
vi.mock('./instance-compaction-handlers', () => ({ registerInstanceCompactionHandlers: () => undefined }));
vi.mock('./instance-cross-session-messaging-handlers', () => ({ registerInstanceCrossSessionMessagingHandlers: () => undefined }));
vi.mock('./instance-computer-use-handler', () => ({ registerInstanceComputerUseHandler: () => undefined }));
import { registerInstanceHandlers } from './instance-handlers';
const createInstance = vi.fn(async (_config: Record<string, unknown>) => ({ id: 'created-session', provider: 'opencode' }));
beforeEach(() => {
  createInstance.mockClear(); handlers.clear();
  registerInstanceHandlers({ instanceManager: { createInstance } as unknown as InstanceManager, windowManager: {} as WindowManager });
});
describe.each([IPC_CHANNELS.INSTANCE_CREATE, IPC_CHANNELS.INSTANCE_CREATE_WITH_MESSAGE])('creation channel %s', (channel) => {
  it('preserves validated extra folders into actual shared creation config', async () => {
    const additionalDirectories = ['/repo/other', 'C:\\work\\second'];
    const bridge = createInstanceDomain({ invoke: (name: string, payload: unknown) => handlers.get(name)!({}, payload) } as IpcRenderer, IPC_CHANNELS);
    const result = channel === IPC_CHANNELS.INSTANCE_CREATE
      ? await bridge.createInstance({ workingDirectory: '/repo', provider: 'opencode', additionalDirectories })
      : await bridge.createInstanceWithMessage({ workingDirectory: '/repo', provider: 'opencode', message: 'work', additionalDirectories });
    expect(result.success).toBe(true);
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: '/repo', provider: 'opencode', additionalDirectories }));
    expect(createInstance.mock.calls[0][0]['additionalDirectories']).not.toBe(additionalDirectories);
  });
  it('refuses extra folders for another provider before creation', async () => {
    expect((await handlers.get(channel)!({}, { workingDirectory: '/repo', provider: 'claude', message: 'work', additionalDirectories: ['/other'] })).success).toBe(false);
    expect(createInstance).not.toHaveBeenCalled();
  });
});
