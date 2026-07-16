import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type IpcResponse } from '../../../../shared/types/ipc.types';
import type { CommandTemplate, ParsedCommand } from '../../../../shared/types/command.types';
import type { Instance } from '../../../../shared/types/instance.types';
import type { LoopConfig, LoopState } from '../../../../shared/types/loop.types';

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
  loopCoordinator: {
    startLoop: vi.fn(),
    getActiveLoops: vi.fn(),
    pauseLoop: vi.fn(),
    resumeLoop: vi.fn(),
    cancelLoop: vi.fn(),
    getLoop: vi.fn(),
  },
  loopStore: {
    upsertRun: vi.fn(),
  },
  prepareLoopStartConfig: vi.fn(),
  appendLoopStartPrompt: vi.fn(),
  chatService: {
    tryGetChat: vi.fn(),
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

vi.mock('../../../orchestration/loop-coordinator', () => ({
  getLoopCoordinator: () => mocks.loopCoordinator,
}));

vi.mock('../../../orchestration/loop-store', () => ({
  getLoopStore: () => mocks.loopStore,
}));

vi.mock('../../../orchestration/loop-start-config', () => ({
  prepareLoopStartConfig: mocks.prepareLoopStartConfig,
}));

vi.mock('../loop-transcript-dispatch', () => ({
  appendLoopStartPrompt: mocks.appendLoopStartPrompt,
}));

vi.mock('../../../chats', () => ({
  getChatService: () => mocks.chatService,
}));

import { registerCommandHandlers } from '../command-handlers';

const goalCommand: CommandTemplate = {
  id: 'builtin-goal',
  name: 'goal',
  description: 'Set or manage an active goal',
  template: '',
  execution: { type: 'goal' },
  applicability: { requiresWorkingDirectory: true },
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
    outputBuffer: [],
  } as unknown as Instance;
}

function makeInstanceManager(instance = makeInstance()) {
  return {
    getInstance: vi.fn(() => instance),
    sendInput: vi.fn().mockResolvedValue(undefined),
    emitSystemMessage: vi.fn(),
  };
}

function makeLoopState(config: Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string }): LoopState {
  return {
    id: 'loop-goal-1',
    chatId: 'inst-1',
    config: config as LoopConfig,
    status: 'running',
    startedAt: 1,
    endedAt: null,
    currentStage: 'IMPLEMENT',
    totalIterations: 0,
    totalTokens: 0,
    totalCostCents: 0,
    lastIteration: null,
    pendingInterventions: [],
    errors: [],
    filesChanged: [],
    convergenceNote: null,
    manualReviewOnly: true,
  } as unknown as LoopState;
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
    mocks.prepareLoopStartConfig.mockImplementation(async (config: unknown) => config);
    mocks.loopCoordinator.startLoop.mockImplementation(async (chatId: string, config: Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string }) => ({
      ...makeLoopState(config),
      chatId,
    }));
    mocks.loopCoordinator.getActiveLoops.mockReturnValue([]);
    mocks.loopCoordinator.pauseLoop.mockReturnValue(true);
    mocks.loopCoordinator.resumeLoop.mockReturnValue(true);
    mocks.loopCoordinator.cancelLoop.mockResolvedValue(true);
    mocks.loopCoordinator.getLoop.mockReturnValue(undefined);
  });

  it('starts Loop Mode for /goal objectives instead of forwarding a provider slash command', async () => {
    mocks.commandManager.executeCommand.mockResolvedValue(makeParsedGoal(['ship', 'settings']));
    const instanceManager = makeInstanceManager();
    registerCommandHandlers(instanceManager as never);

    const response = await invoke(IPC_CHANNELS.COMMAND_EXECUTE, {
      instanceId: 'inst-1',
      commandId: 'builtin-goal',
      args: ['ship', 'settings'],
    });

    expect(response.success).toBe(true);
    expect(instanceManager.sendInput).not.toHaveBeenCalled();
    expect(mocks.prepareLoopStartConfig).toHaveBeenCalledWith(expect.objectContaining({
      initialPrompt: 'ship settings',
      workspaceCwd: '/tmp/project',
      provider: 'claude',
      goalIntent: 'implementation',
      completion: expect.objectContaining({
        mode: 'gated',
        verifyCommand: '',
        allowOperatorReviewedCompletion: true,
      }),
    }));
    expect(mocks.loopCoordinator.startLoop).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ initialPrompt: 'ship settings', workspaceCwd: '/tmp/project' }),
      undefined,
      { existingSessionContext: undefined },
    );
    expect(mocks.loopStore.upsertRun).toHaveBeenCalledWith(expect.objectContaining({
      id: 'loop-goal-1',
      chatId: 'inst-1',
    }));
    expect(mocks.appendLoopStartPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'loop-goal-1', chatId: 'inst-1' }),
      mocks.chatService,
      instanceManager,
    );
    expect(mocks.usageTracker.record).toHaveBeenCalledWith('command', 'builtin-goal', '/tmp/project');
    expect(response.data).toEqual(expect.objectContaining({
      goal: { action: 'started', loopRunId: 'loop-goal-1' },
    }));
  });

  it('allows /goal for non-Claude/Codex providers because Loop Mode owns execution', async () => {
    mocks.commandManager.executeCommand.mockResolvedValue(makeParsedGoal(['ship', 'settings']));
    const instanceManager = makeInstanceManager(makeInstance('gemini'));
    registerCommandHandlers(instanceManager as never);

    const response = await invoke(IPC_CHANNELS.COMMAND_EXECUTE, {
      instanceId: 'inst-1',
      commandId: 'builtin-goal',
      args: ['ship', 'settings'],
    });

    expect(response.success).toBe(true);
    expect(instanceManager.sendInput).not.toHaveBeenCalled();
    expect(mocks.loopCoordinator.startLoop).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ provider: 'gemini' }),
      undefined,
      { existingSessionContext: undefined },
    );
  });

  it('reports /goal status through a visible system message without starting a loop', async () => {
    mocks.commandManager.executeCommand.mockResolvedValue(makeParsedGoal([]));
    const instanceManager = makeInstanceManager();
    registerCommandHandlers(instanceManager as never);

    const response = await invoke(IPC_CHANNELS.COMMAND_EXECUTE, {
      instanceId: 'inst-1',
      commandId: 'builtin-goal',
      args: [],
    });

    expect(response.success).toBe(true);
    expect(mocks.loopCoordinator.startLoop).not.toHaveBeenCalled();
    expect(instanceManager.sendInput).not.toHaveBeenCalled();
    expect(instanceManager.emitSystemMessage).toHaveBeenCalledWith(
      'inst-1',
      'No active goal loop is set for this session.',
      expect.objectContaining({ source: 'goal-command', action: 'status', status: 'none' }),
    );
    expect(response.data).toEqual(expect.objectContaining({
      goal: { action: 'status', loopRunId: null },
    }));
  });

  it('ignores terminal provider-limit loops for /goal status', async () => {
    mocks.commandManager.executeCommand.mockResolvedValue(makeParsedGoal([]));
    const endedProviderLimit = {
      ...makeLoopState({
        initialPrompt: 'ship settings',
        workspaceCwd: '/tmp/project',
      }),
      status: 'provider-limit' as const,
      endedAt: 1_778_313_000_000,
      endReason: 'provider limit reached without a reset window',
    };
    mocks.loopCoordinator.getActiveLoops.mockReturnValue([endedProviderLimit]);
    const instanceManager = makeInstanceManager();
    registerCommandHandlers(instanceManager as never);

    const response = await invoke(IPC_CHANNELS.COMMAND_EXECUTE, {
      instanceId: 'inst-1',
      commandId: 'builtin-goal',
      args: [],
    });

    expect(response.success).toBe(true);
    expect(instanceManager.emitSystemMessage).toHaveBeenCalledWith(
      'inst-1',
      'No active goal loop is set for this session.',
      expect.objectContaining({ source: 'goal-command', action: 'status', status: 'none' }),
    );
    expect(response.data).toEqual(expect.objectContaining({
      goal: { action: 'status', loopRunId: null },
    }));
  });

  it('pauses the active /goal loop instead of sending provider text', async () => {
    mocks.commandManager.executeCommand.mockResolvedValue(makeParsedGoal(['pause']));
    const active = makeLoopState({
      initialPrompt: 'ship settings',
      workspaceCwd: '/tmp/project',
    });
    const paused = { ...active, status: 'paused' as const };
    mocks.loopCoordinator.getActiveLoops.mockReturnValue([active]);
    mocks.loopCoordinator.getLoop.mockReturnValue(paused);
    const instanceManager = makeInstanceManager();
    registerCommandHandlers(instanceManager as never);

    const response = await invoke(IPC_CHANNELS.COMMAND_EXECUTE, {
      instanceId: 'inst-1',
      commandId: 'builtin-goal',
      args: ['pause'],
    });

    expect(response.success).toBe(true);
    expect(mocks.loopCoordinator.pauseLoop).toHaveBeenCalledWith(active.id);
    expect(mocks.loopStore.upsertRun).toHaveBeenCalledWith(paused);
    expect(instanceManager.sendInput).not.toHaveBeenCalled();
    expect(instanceManager.emitSystemMessage).toHaveBeenCalledWith(
      'inst-1',
      `Goal loop ${active.id} paused.`,
      expect.objectContaining({ source: 'goal-command', action: 'pause', loopRunId: active.id, status: 'paused' }),
    );
  });
});

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = mocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler({}, payload);
}
