import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type IpcResponse } from '../../../../shared/types/ipc.types';
import type { CommandTemplate, ParsedCommand } from '../../../../shared/types/command.types';
import type { Instance } from '../../../../shared/types/instance.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  commandManager: {
    executeCommand: vi.fn(),
    getAllCommandsSnapshot: vi.fn(),
  },
  contextEngine: {
    compactInstance: vi.fn(),
  },
  usageTracker: {
    record: vi.fn(),
  },
  emitPluginHook: vi.fn(),
  isGitRepository: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../commands/command-manager', () => ({
  getCommandManager: () => mocks.commandManager,
}));

vi.mock('../../../plugins/hook-emitter', () => ({
  emitPluginHook: mocks.emitPluginHook,
}));

vi.mock('../../../context/context-engine', () => ({
  getContextEngine: () => mocks.contextEngine,
}));

vi.mock('../../../git/git-probe-service', () => ({
  isGitRepository: mocks.isGitRepository,
}));

vi.mock('../../../usage/usage-tracker', () => ({
  getUsageTracker: () => mocks.usageTracker,
}));

import { registerCommandHandlers } from '../command-handlers';

const goalCommand: CommandTemplate = {
  id: 'builtin-goal',
  name: 'goal',
  description: 'Set or manage an active goal',
  template: '',
  execution: { type: 'goal' },
  applicability: { provider: ['claude', 'codex'] },
  builtIn: true,
  createdAt: 1,
  updatedAt: 1,
};

function makeParsedGoal(args: string[]): ParsedCommand {
  return {
    command: goalCommand,
    args,
    resolvedPrompt: '',
    execution: { type: 'goal' },
  };
}

function makeInstance(provider: Instance['provider'] = 'claude'): Instance {
  return {
    id: 'inst-1',
    provider,
    status: 'idle',
    workingDirectory: '/tmp/project',
  } as Instance;
}

function makeInstanceManager(instance = makeInstance()) {
  return {
    getInstance: vi.fn(() => instance),
    sendInput: vi.fn().mockResolvedValue(undefined),
  };
}

describe('registerCommandHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.commandManager.getAllCommandsSnapshot.mockResolvedValue({
      commands: [goalCommand],
      diagnostics: [],
      scanDirs: [],
    });
  });

  it('routes /goal execution back through InstanceManager slash handling', async () => {
    mocks.commandManager.executeCommand.mockResolvedValue(makeParsedGoal(['ship', 'settings']));
    const instanceManager = makeInstanceManager();
    registerCommandHandlers(instanceManager as never);

    const response = await invoke(IPC_CHANNELS.COMMAND_EXECUTE, {
      instanceId: 'inst-1',
      commandId: 'builtin-goal',
      args: ['ship', 'settings'],
    });

    expect(response.success).toBe(true);
    expect(instanceManager.sendInput).toHaveBeenCalledWith('inst-1', '/goal ship settings');
    expect(mocks.usageTracker.record).toHaveBeenCalledWith('command', 'builtin-goal', '/tmp/project');
  });

  it('blocks /goal for providers that do not support the command', async () => {
    mocks.commandManager.executeCommand.mockResolvedValue(makeParsedGoal(['ship', 'settings']));
    const instanceManager = makeInstanceManager(makeInstance('gemini'));
    registerCommandHandlers(instanceManager as never);

    const response = await invoke(IPC_CHANNELS.COMMAND_EXECUTE, {
      instanceId: 'inst-1',
      commandId: 'builtin-goal',
      args: ['ship', 'settings'],
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('COMMAND_INELIGIBLE');
    expect(instanceManager.sendInput).not.toHaveBeenCalled();
  });
});

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = mocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler({}, payload);
}
