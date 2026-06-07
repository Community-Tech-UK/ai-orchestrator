import { describe, expect, it, vi } from 'vitest';
import { createThinClientCommandExecutor } from './thin-client-command-executor';

describe('createThinClientCommandExecutor', () => {
  it('implements the instance remote-control command subset', async () => {
    const instanceManager = {
      getAllInstancesForIpc: vi.fn(() => [{ id: 'inst-1' }]),
      createInstance: vi.fn(async () => ({
        id: 'inst-2',
        displayName: 'Created',
        communicationTokens: new Map([['provider', 1]]),
      })),
      sendInput: vi.fn(async () => undefined),
      terminateInstance: vi.fn(async () => undefined),
      interruptInstance: vi.fn(() => true),
      hibernateInstance: vi.fn(async () => undefined),
      wakeInstance: vi.fn(async () => undefined),
    };
    const execute = createThinClientCommandExecutor({
      instanceManager,
      getDefaultWorkingDirectory: () => '/default-workspace',
    });

    await expect(execute('instance:list', { ipcAuthToken: 'secret' })).resolves.toEqual({
      success: true,
      data: [{ id: 'inst-1' }],
    });
    await expect(execute('instance:create', {
      ipcAuthToken: 'secret',
      workingDirectory: '.',
      provider: 'claude',
    })).resolves.toEqual({
      success: true,
      data: {
        id: 'inst-2',
        displayName: 'Created',
        communicationTokens: { provider: 1 },
      },
    });
    await execute('instance:send-input', {
      ipcAuthToken: 'secret',
      instanceId: 'inst-1',
      message: 'hello',
    });
    await execute('instance:terminate', {
      ipcAuthToken: 'secret',
      instanceId: 'inst-1',
      graceful: false,
    });
    await expect(execute('instance:interrupt', {
      ipcAuthToken: 'secret',
      instanceId: 'inst-1',
    })).resolves.toEqual({
      success: true,
      data: { interrupted: true },
    });
    await execute('instance:hibernate', { ipcAuthToken: 'secret', instanceId: 'inst-1' });
    await execute('instance:wake', { ipcAuthToken: 'secret', instanceId: 'inst-1' });

    expect(instanceManager.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: '/default-workspace', provider: 'claude' }),
    );
    expect(instanceManager.sendInput).toHaveBeenCalledWith('inst-1', 'hello', undefined, {
      isRetry: undefined,
    });
    expect(instanceManager.terminateInstance).toHaveBeenCalledWith('inst-1', false);
    expect(instanceManager.hibernateInstance).toHaveBeenCalledWith('inst-1');
    expect(instanceManager.wakeInstance).toHaveBeenCalledWith('inst-1');
  });

  it('implements interaction response commands', async () => {
    const respondToUserAction = vi.fn();
    const instanceManager = {
      getAllInstancesForIpc: vi.fn(() => []),
      createInstance: vi.fn(async () => ({})),
      sendInput: vi.fn(async () => undefined),
      terminateInstance: vi.fn(async () => undefined),
      interruptInstance: vi.fn(() => false),
      hibernateInstance: vi.fn(async () => undefined),
      wakeInstance: vi.fn(async () => undefined),
      sendInputResponse: vi.fn(async () => undefined),
      clearPendingInputRequiredPermission: vi.fn(),
      recordInputRequiredPermissionDecision: vi.fn(),
      getOrchestrationHandler: vi.fn(() => ({ respondToUserAction })),
    };
    const execute = createThinClientCommandExecutor({
      instanceManager,
      pauseCoordinator: { isPaused: () => false },
      remoteObserver: { clearPrompt: vi.fn() },
    });

    await expect(execute('instance:respond-input', {
      ipcAuthToken: 'secret',
      instanceId: 'inst-1',
      requestId: 'req-1',
      response: 'approved',
      permissionKey: 'perm-key',
    })).resolves.toEqual({
      success: true,
      data: { requestId: 'req-1', responded: true },
    });
    await expect(execute('instance:respond-action', {
      ipcAuthToken: 'secret',
      requestId: 'action-1',
      approved: false,
      selectedOption: 'deny',
    })).resolves.toEqual({
      success: true,
      data: { requestId: 'action-1', responded: true },
    });

    expect(instanceManager.sendInputResponse).toHaveBeenCalledWith('inst-1', 'approved', 'perm-key');
    expect(instanceManager.clearPendingInputRequiredPermission).toHaveBeenCalledWith('inst-1', 'req-1');
    expect(respondToUserAction).toHaveBeenCalledWith('action-1', false, 'deny');
  });

  it('implements loop command vocabulary against the loop coordinator', async () => {
    const state = {
      id: 'loop-1',
      chatId: 'chat-1',
      status: 'running',
      config: { initialPrompt: 'goal', workspaceCwd: '/workspace' },
    };
    const loopCoordinator = {
      startLoop: vi.fn(async () => state),
      pauseLoop: vi.fn(() => true),
      resumeLoop: vi.fn(() => true),
      cancelLoop: vi.fn(async () => true),
      intervene: vi.fn(() => true),
      acceptCompletion: vi.fn(async () => true),
      getLoop: vi.fn(() => state),
    };
    const loopStore = { upsertRun: vi.fn() };
    const execute = createThinClientCommandExecutor({
      instanceManager: makeBaseInstanceManager(),
      loopCoordinator,
      loopStore,
      chatService: {
        tryGetChat: vi.fn(() => null),
        appendSystemEvent: vi.fn(async () => undefined),
      },
      prepareLoopStartConfig: vi.fn(async (config) => ({
        ...config,
        provider: 'claude',
        reviewStyle: 'single',
        contextStrategy: 'fresh-child',
        allowDestructiveOps: false,
        initialStage: 'IMPLEMENT',
      })),
    });

    await expect(execute('loop:start', {
      ipcAuthToken: 'secret',
      chatId: 'chat-1',
      config: { initialPrompt: 'goal', workspaceCwd: '/workspace' },
    })).resolves.toEqual({ success: true, data: { state } });
    await expect(execute('loop:pause', { ipcAuthToken: 'secret', loopRunId: 'loop-1' }))
      .resolves.toEqual({ success: true, data: { ok: true, state } });
    await expect(execute('loop:resume', { ipcAuthToken: 'secret', loopRunId: 'loop-1' }))
      .resolves.toEqual({ success: true, data: { ok: true, state } });
    await expect(execute('loop:intervene', {
      ipcAuthToken: 'secret',
      loopRunId: 'loop-1',
      message: 'nudge',
    })).resolves.toEqual({ success: true, data: { ok: true } });
    await expect(execute('loop:cancel', { ipcAuthToken: 'secret', loopRunId: 'loop-1' }))
      .resolves.toEqual({ success: true, data: { ok: true, state } });
    await expect(execute('loop:accept-completion', { ipcAuthToken: 'secret', loopRunId: 'loop-1' }))
      .resolves.toEqual({ success: true, data: { ok: true, state } });

    expect(loopCoordinator.startLoop).toHaveBeenCalledOnce();
    expect(loopCoordinator.pauseLoop).toHaveBeenCalledWith('loop-1');
    expect(loopCoordinator.resumeLoop).toHaveBeenCalledWith('loop-1');
    expect(loopCoordinator.intervene).toHaveBeenCalledWith('loop-1', 'nudge');
    expect(loopCoordinator.cancelLoop).toHaveBeenCalledWith('loop-1');
    expect(loopCoordinator.acceptCompletion).toHaveBeenCalledWith('loop-1');
    expect(loopStore.upsertRun).toHaveBeenCalled();
  });

  it('implements chat command vocabulary against the chat service', async () => {
    const chatService = {
      initialize: vi.fn(),
      listChats: vi.fn(() => [{ id: 'chat-1' }]),
      getChat: vi.fn(async () => ({ id: 'chat-1' })),
      createChat: vi.fn(async () => ({ id: 'chat-2' })),
      sendMessage: vi.fn(async () => ({ messageId: 'msg-1' })),
    };
    const execute = createThinClientCommandExecutor({
      instanceManager: makeBaseInstanceManager(),
      chatService,
    });

    await expect(execute('chat:list', { ipcAuthToken: 'secret' }))
      .resolves.toEqual({ success: true, data: [{ id: 'chat-1' }] });
    await expect(execute('chat:get', { ipcAuthToken: 'secret', chatId: 'chat-1' }))
      .resolves.toEqual({ success: true, data: { id: 'chat-1' } });
    await expect(execute('chat:create', {
      ipcAuthToken: 'secret',
      provider: 'claude',
      currentCwd: '/workspace',
    })).resolves.toEqual({ success: true, data: { id: 'chat-2' } });
    await expect(execute('chat:send-message', {
      ipcAuthToken: 'secret',
      chatId: 'chat-1',
      text: 'hello',
    })).resolves.toEqual({ success: true, data: { messageId: 'msg-1' } });

    expect(chatService.listChats).toHaveBeenCalledWith({});
    expect(chatService.getChat).toHaveBeenCalledWith('chat-1');
    expect(chatService.createChat).toHaveBeenCalledWith({
      provider: 'claude',
      currentCwd: '/workspace',
    });
    expect(chatService.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      text: 'hello',
    });
  });

  it('implements snapshot and resumable-session command vocabulary', async () => {
    const snapshotManager = {
      takeSnapshot: vi.fn(() => 'snapshot-1'),
    };
    const sessionContinuityManager = {
      getResumableSessions: vi.fn(async () => [{ id: 'session-1' }]),
    };
    const execute = createThinClientCommandExecutor({
      instanceManager: makeBaseInstanceManager(),
      snapshotManager,
      sessionContinuityManager,
    });

    await expect(execute('snapshot:take', {
      ipcAuthToken: 'secret',
      filePath: '/tmp/file.txt',
      instanceId: 'inst-1',
      sessionId: 'session-1',
      action: 'modify',
    })).resolves.toEqual({
      success: true,
      data: { snapshotId: 'snapshot-1' },
    });
    await expect(execute('session:list-resumable', { ipcAuthToken: 'secret' }))
      .resolves.toEqual({ success: true, data: [{ id: 'session-1' }] });

    expect(snapshotManager.takeSnapshot).toHaveBeenCalledWith(
      '/tmp/file.txt',
      'inst-1',
      'session-1',
      'modify',
    );
    expect(sessionContinuityManager.getResumableSessions).toHaveBeenCalledOnce();
  });
});

function makeBaseInstanceManager() {
  return {
    getAllInstancesForIpc: vi.fn(() => []),
    createInstance: vi.fn(async () => ({})),
    sendInput: vi.fn(async () => undefined),
    terminateInstance: vi.fn(async () => undefined),
    interruptInstance: vi.fn(() => false),
    hibernateInstance: vi.fn(async () => undefined),
    wakeInstance: vi.fn(async () => undefined),
    getInstance: vi.fn(() => null),
    appendSyntheticUserMessage: vi.fn(),
  };
}
