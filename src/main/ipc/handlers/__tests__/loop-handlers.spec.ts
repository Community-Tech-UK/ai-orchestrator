import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopConfigInput } from '@contracts/schemas/loop';
import type { InstanceManager } from '../../../instance/instance-manager';
import { defaultLoopConfig, type LoopState } from '../../../../shared/types/loop.types';
import { buildExistingSessionContext, registerLoopHandlers } from '../loop-handlers';

const hoisted = vi.hoisted(() => ({
  coordinator: {
    registerIterationHook: vi.fn(),
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
    getRunSummary: vi.fn(),
    listRunsForChat: vi.fn(),
    getIterations: vi.fn(),
  },
  chatService: {
    appendSystemEvent: vi.fn(),
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

function makeInstanceManager(outputBuffer: unknown[]): InstanceManager {
  return {
    getInstance: vi.fn(() => ({ outputBuffer })),
  } as unknown as InstanceManager;
}

beforeEach(() => {
  vi.clearAllMocks();
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
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    ...overrides,
  };
}
