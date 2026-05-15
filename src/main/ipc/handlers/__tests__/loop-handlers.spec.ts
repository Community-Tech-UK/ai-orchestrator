import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopConfigInput } from '@contracts/schemas/loop';
import { IPC_CHANNELS } from '@contracts/channels';
import type { InstanceManager } from '../../../instance/instance-manager';
import { defaultLoopConfig, type LoopState } from '../../../../shared/types/loop.types';
import { buildExistingSessionContext, registerLoopHandlers } from '../loop-handlers';
import { ipcMain } from 'electron';

const hoisted = vi.hoisted(() => ({
  coordinator: {
    registerIterationHook: vi.fn(),
    setIntentPersistHook: vi.fn(),
    on: vi.fn(),
    startLoop: vi.fn(),
    pauseLoop: vi.fn(),
    resumeLoop: vi.fn(),
    intervene: vi.fn(),
    cancelLoop: vi.fn(),
    getLoop: vi.fn(),
  },
  store: {
    upsertRun: vi.fn(),
    insertIteration: vi.fn(),
    upsertTerminalIntent: vi.fn(),
    getRunSummary: vi.fn(),
    listRunsForChat: vi.fn(),
    getIterations: vi.fn(),
  },
  chatService: {
    appendSystemEvent: vi.fn(),
    tryGetChat: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../orchestration/loop-coordinator', () => ({
  getLoopCoordinator: () => hoisted.coordinator,
}));

vi.mock('../../../orchestration/loop-store', () => ({
  getLoopStore: () => hoisted.store,
}));

vi.mock('../../../chats', () => ({
  getChatService: () => hoisted.chatService,
}));

function makeConfig(initialPrompt = 'Please continue the current implementation.'): LoopConfigInput {
  return {
    initialPrompt,
    workspaceCwd: '/tmp/project',
  };
}

function makeInstanceManager(
  outputBuffer: unknown[],
  overrides: Partial<{
    getInstance: ReturnType<typeof vi.fn>;
    appendSyntheticUserMessage: ReturnType<typeof vi.fn>;
    emitSystemMessage: ReturnType<typeof vi.fn>;
  }> = {},
): InstanceManager {
  return {
    getInstance: overrides.getInstance ?? vi.fn(() => ({ outputBuffer })),
    appendSyntheticUserMessage: overrides.appendSyntheticUserMessage ?? vi.fn(),
    emitSystemMessage: overrides.emitSystemMessage ?? vi.fn(),
  } as unknown as InstanceManager;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: behave as if state.chatId is a real chat. Individual tests can
  // override this to exercise the instance-id fallback path.
  hoisted.chatService.tryGetChat.mockReturnValue({ id: 'chat-1' });
});

describe('buildExistingSessionContext', () => {
  it('builds runtime-only recent visible-session transcript context for an existing-session loop', () => {
    const marker = 'EXISTING_CONTEXT_MARKER_54291';
    const config = makeConfig('Use the previous context to write the marker to disk.');
    const instanceManager = makeInstanceManager([
      {
        id: 'msg-1',
        type: 'user',
        content: `Remember this marker for the next continuation: ${marker}`,
        timestamp: 1,
      },
      {
        id: 'msg-2',
        type: 'assistant',
        content: 'I will use that marker when continuing.',
        timestamp: 2,
      },
    ]);

    const context = buildExistingSessionContext(
      instanceManager,
      'chat-existing',
    );

    expect(config.initialPrompt).toBe('Use the previous context to write the marker to disk.');
    expect(context).toContain('<conversation_history>');
    expect(context).toContain(marker);
    expect(context).toContain('read-only background');
  });

  it('leaves new or transcriptless loop starts unchanged', () => {
    const instanceManager = makeInstanceManager([]);

    const result = buildExistingSessionContext(instanceManager, 'chat-empty');

    expect(result).toBeUndefined();
  });
});

describe('registerLoopHandlers terminal summaries', () => {
  it('appends a durable chat summary when a loop enters a terminal state', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const state = makeLoopState();
    const stateHandler = hoisted.coordinator.on.mock.calls.find((call) =>
      call[0] === 'loop:state-changed'
    )?.[1] as ((data: { loopRunId: string; state: LoopState }) => void) | undefined;

    stateHandler?.({ loopRunId: state.id, state });

    expect(hoisted.store.upsertRun).toHaveBeenCalledWith(state);
    expect(hoisted.chatService.appendSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        nativeMessageId: 'loop-summary:loop-1',
        content: expect.stringContaining('Loop ended - completed'),
      }),
    );
    expect(windowManager.sendToRenderer).toHaveBeenCalledWith(
      'loop:state-changed',
      { loopRunId: state.id, state },
    );
  });

  it('does not append a chat summary for non-terminal loop state changes', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const state = makeLoopState({ status: 'running', endedAt: null });
    const stateHandler = hoisted.coordinator.on.mock.calls.find((call) =>
      call[0] === 'loop:state-changed'
    )?.[1] as ((data: { loopRunId: string; state: LoopState }) => void) | undefined;

    stateHandler?.({ loopRunId: state.id, state });

    expect(hoisted.chatService.appendSystemEvent).not.toHaveBeenCalled();
  });
});

describe('LOOP_START handler — kickoff prompt persistence', () => {
  // We persist the kickoff prompt synchronously inside the LOOP_START IPC
  // handler (rather than from the `loop:started` listener) so the chat
  // ledger or instance outputBuffer carries the user-role bubble BEFORE
  // the renderer receives the LOOP_START response and runs its own
  // `upsertActive(state)`. Tests below drive the IPC handler directly.

  function defaultStartPayload(): unknown {
    return {
      chatId: 'chat-1',
      config: { initialPrompt: 'Build the thing.', workspaceCwd: '/work/project' },
      attachments: undefined,
    };
  }

  it('appends a durable user-role chat event the moment a loop starts so it stays visible if it never reaches a terminal state', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    const startState = makeLoopState({ status: 'running', endedAt: null });
    hoisted.coordinator.startLoop.mockResolvedValue(startState);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_START);

    const response = await handler({}, defaultStartPayload());

    expect(hoisted.coordinator.startLoop).toHaveBeenCalled();
    expect(hoisted.chatService.appendSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        nativeMessageId: 'loop-start:loop-1',
        phase: 'loop_start',
        role: 'user',
        content: 'Build the thing.',
        autoName: true,
      }),
    );
    expect(response).toEqual({ success: true, data: { state: startState } });
  });

  it('falls back to InstanceManager.appendSyntheticUserMessage when state.chatId is an instance id (instance-detail loop)', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const appendSyntheticUserMessage = vi.fn();
    const instanceManager = makeInstanceManager([], {
      getInstance: vi.fn(() => ({ id: 'inst-1', outputBuffer: [] })),
      appendSyntheticUserMessage,
    });
    const startState = makeLoopState({ status: 'running', endedAt: null });
    hoisted.coordinator.startLoop.mockResolvedValue(startState);
    // The chatId on state is actually an instance id, so tryGetChat returns null.
    hoisted.chatService.tryGetChat.mockReturnValue(null);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_START);

    await handler({}, defaultStartPayload());

    expect(hoisted.chatService.appendSystemEvent).not.toHaveBeenCalled();
    expect(appendSyntheticUserMessage).toHaveBeenCalledWith(
      'chat-1',
      'Build the thing.',
      expect.objectContaining({
        autoTitle: true,
        metadata: expect.objectContaining({
          kind: 'loop-start',
          loopRunId: 'loop-1',
        }),
      }),
    );
  });

  it('still returns the new state when chatId resolves to neither a chat nor an instance', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([], {
      getInstance: vi.fn(() => undefined),
    });
    const startState = makeLoopState({ status: 'running', endedAt: null, chatId: 'orphan-1' });
    hoisted.coordinator.startLoop.mockResolvedValue(startState);
    hoisted.chatService.tryGetChat.mockReturnValue(null);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_START);

    const response = await handler({}, { ...(defaultStartPayload() as object), chatId: 'orphan-1' });

    expect(hoisted.chatService.appendSystemEvent).not.toHaveBeenCalled();
    expect(response).toEqual({ success: true, data: { state: startState } });
  });

  it('swallows chat-append failures so the LOOP_START response still succeeds', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    const startState = makeLoopState({ status: 'running', endedAt: null });
    hoisted.coordinator.startLoop.mockResolvedValue(startState);
    hoisted.chatService.appendSystemEvent.mockImplementationOnce(() => {
      throw new Error('chat missing');
    });
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_START);

    const response = await handler({}, defaultStartPayload());

    expect(response).toEqual({ success: true, data: { state: startState } });
  });

  it('forwards the loop:started event to the renderer without re-appending the kickoff prompt', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const startHandler = hoisted.coordinator.on.mock.calls.find((call) =>
      call[0] === 'loop:started'
    )?.[1] as ((data: { loopRunId: string; chatId: string }) => void) | undefined;

    startHandler?.({ loopRunId: 'loop-1', chatId: 'chat-1' });

    // The listener forwards to the renderer but does NOT call appendSystemEvent
    // or appendSyntheticUserMessage — that responsibility moved to the
    // LOOP_START IPC handler so persistence runs ahead of the IPC response.
    expect(hoisted.chatService.appendSystemEvent).not.toHaveBeenCalled();
    expect(windowManager.sendToRenderer).toHaveBeenCalledWith(
      'loop:started',
      { loopRunId: 'loop-1', chatId: 'chat-1' },
    );
  });
});

describe('LOOP_INTERVENE handler', () => {
  it('persists the user nudge as a user-role chat event when the coordinator accepts it', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    const state = makeLoopState({ status: 'running', endedAt: null });
    hoisted.coordinator.intervene.mockReturnValue(true);
    hoisted.coordinator.getLoop.mockReturnValue(state);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_INTERVENE);

    const response = await handler({}, { loopRunId: state.id, message: 'try a different angle' });

    expect(hoisted.coordinator.intervene).toHaveBeenCalledWith(state.id, 'try a different angle');
    expect(hoisted.chatService.appendSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: state.chatId,
        nativeTurnId: 'loop:loop-1',
        phase: 'loop_intervene',
        role: 'user',
        content: 'try a different angle',
        nativeMessageId: expect.stringMatching(/^loop-intervene:loop-1:[0-9a-f-]{8,}/i),
      }),
    );
    expect(response).toEqual({ success: true, data: { ok: true } });
  });

  it('does not append a chat event when the coordinator rejects the intervention', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    hoisted.coordinator.intervene.mockReturnValue(false);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_INTERVENE);

    const response = await handler({}, { loopRunId: 'loop-gone', message: 'too late' });

    expect(hoisted.chatService.appendSystemEvent).not.toHaveBeenCalled();
    expect(response).toEqual({ success: true, data: { ok: false } });
  });

  it('generates a distinct interventionId per call so rapid double-clicks both land in the transcript', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    const state = makeLoopState({ status: 'running', endedAt: null });
    hoisted.coordinator.intervene.mockReturnValue(true);
    hoisted.coordinator.getLoop.mockReturnValue(state);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_INTERVENE);

    await handler({}, { loopRunId: state.id, message: 'first' });
    await handler({}, { loopRunId: state.id, message: 'second' });

    expect(hoisted.chatService.appendSystemEvent).toHaveBeenCalledTimes(2);
    const firstId = (hoisted.chatService.appendSystemEvent.mock.calls[0]?.[0] as { nativeMessageId: string }).nativeMessageId;
    const secondId = (hoisted.chatService.appendSystemEvent.mock.calls[1]?.[0] as { nativeMessageId: string }).nativeMessageId;
    expect(firstId).not.toBe(secondId);
  });

  it('falls back to InstanceManager.appendSyntheticUserMessage for instance-detail loops', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const appendSyntheticUserMessage = vi.fn();
    const instanceManager = makeInstanceManager([], {
      getInstance: vi.fn(() => ({ id: 'inst-1', outputBuffer: [] })),
      appendSyntheticUserMessage,
    });
    const state = makeLoopState({ status: 'running', endedAt: null });
    hoisted.coordinator.intervene.mockReturnValue(true);
    hoisted.coordinator.getLoop.mockReturnValue(state);
    hoisted.chatService.tryGetChat.mockReturnValue(null);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_INTERVENE);

    await handler({}, { loopRunId: state.id, message: 'pivot to plan B' });

    expect(hoisted.chatService.appendSystemEvent).not.toHaveBeenCalled();
    expect(appendSyntheticUserMessage).toHaveBeenCalledWith(
      state.chatId,
      'pivot to plan B',
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: 'loop-intervene',
          loopRunId: 'loop-1',
        }),
      }),
    );
  });
});

describe('terminal summary instance-id fallback', () => {
  it('routes the terminal summary to InstanceManager.emitSystemMessage for instance-detail loops', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const emitSystemMessage = vi.fn();
    const instanceManager = makeInstanceManager([], {
      getInstance: vi.fn(() => ({ id: 'inst-1', outputBuffer: [] })),
      emitSystemMessage,
    });
    hoisted.chatService.tryGetChat.mockReturnValue(null);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const state = makeLoopState();
    const stateHandler = hoisted.coordinator.on.mock.calls.find((call) =>
      call[0] === 'loop:state-changed'
    )?.[1] as ((data: { loopRunId: string; state: LoopState }) => void) | undefined;

    stateHandler?.({ loopRunId: state.id, state });

    expect(hoisted.chatService.appendSystemEvent).not.toHaveBeenCalled();
    expect(emitSystemMessage).toHaveBeenCalledWith(
      state.chatId,
      expect.stringContaining('Loop ended - completed'),
      expect.objectContaining({ kind: 'loop-summary', loopRunId: 'loop-1' }),
    );
  });
});

type IpcHandler = (event: unknown, payload: unknown) => Promise<{ success: boolean; data?: unknown }>;

function findIpcHandler(channel: string): IpcHandler {
  const handleMock = ipcMain.handle as unknown as { mock: { calls: [string, IpcHandler][] } };
  const call = handleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!call) {
    throw new Error(`No IPC handler registered for ${channel}`);
  }
  return call[1];
}

function makeLoopState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    config: defaultLoopConfig('/work/project', 'Build the thing.'),
    status: 'completed',
    startedAt: 0,
    endedAt: 1_000,
    totalIterations: 1,
    totalTokens: 10,
    totalCostCents: 1,
    currentStage: 'IMPLEMENT',
    endReason: 'signal=done-promise',
    pendingInterventions: [],
    completedFileRenameObserved: false,
    doneSentinelPresentAtStart: false,
    planChecklistFullyCheckedAtStart: false,
    uncompletedPlanFilesAtStart: [],
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    ...overrides,
  };
}
