import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoopConfigInput } from '@contracts/schemas/loop';
import { IPC_CHANNELS } from '@contracts/channels';
import type { InstanceManager } from '../../../instance/instance-manager';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../../../shared/types/loop.types';
import { buildExistingSessionContext, registerLoopHandlers } from '../loop-handlers';
import { ipcMain } from 'electron';

const hoisted = vi.hoisted(() => ({
  coordinator: {
    registerPreIterationHook: vi.fn(),
    registerIterationHook: vi.fn(),
    setIntentPersistHook: vi.fn(),
    on: vi.fn(),
    startLoop: vi.fn(),
    pauseLoop: vi.fn(),
    resumeLoop: vi.fn(),
    restoreLoopFromCheckpoint: vi.fn(),
    intervene: vi.fn(),
    cancelLoop: vi.fn(),
    failLoop: vi.fn(),
    getLoop: vi.fn(),
  },
  store: {
    upsertRun: vi.fn(),
    insertIteration: vi.fn(),
    upsertCheckpoint: vi.fn(),
    persistIterationSnapshot: vi.fn(),
    persistStateCheckpoint: vi.fn(),
    upsertTerminalIntent: vi.fn(),
    getRunSummary: vi.fn(),
    listRunsForChat: vi.fn(),
    getIterations: vi.fn(),
    getCheckpoint: vi.fn(),
    listResumableCheckpoints: vi.fn(),
    getRunConfig: vi.fn(),
    listOutstandingItems: vi.fn(),
    setOutstandingItemStatus: vi.fn(),
  },
  chatService: {
    appendSystemEvent: vi.fn(),
    tryGetChat: vi.fn(),
    bumpLineageEpoch: vi.fn(),
  },
  loopCommitRatchetHook: vi.fn(),
  verificationRunStore: {
    listForLoop: vi.fn(),
    listForInstance: vi.fn(),
  },
}));

let tempWorkspace: string | null = null;

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

vi.mock('../../../orchestration/loop-commit-ratchet', () => ({
  loopCommitRatchetHook: hoisted.loopCommitRatchetHook,
}));

vi.mock('../../../orchestration/verification-run-store', () => ({
  VerificationRunStore: {
    getInstance: () => hoisted.verificationRunStore,
  },
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
  if (tempWorkspace) {
    rmSync(tempWorkspace, { recursive: true, force: true });
    tempWorkspace = null;
  }
  vi.clearAllMocks();
  hoisted.coordinator.getLoop.mockReturnValue(undefined);
  hoisted.coordinator.failLoop.mockReturnValue(true);
  hoisted.loopCommitRatchetHook.mockResolvedValue(undefined);
  hoisted.store.getCheckpoint.mockReturnValue(null);
  hoisted.store.getRunConfig.mockReturnValue(null);
  hoisted.store.listOutstandingItems.mockReturnValue([]);
  hoisted.store.setOutstandingItemStatus.mockReturnValue(true);
  hoisted.verificationRunStore.listForLoop.mockReturnValue([]);
  hoisted.verificationRunStore.listForInstance.mockReturnValue([]);
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
  it('persists a checkpoint whenever loop state changes', () => {
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

    expect(hoisted.store.persistStateCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      state,
      checkpoint: expect.objectContaining({
        loopRunId: state.id,
        chatId: state.chatId,
        status: state.status,
      }),
    }));
  });

  it('persists a checkpoint when an iteration is sealed', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const iterationHook = hoisted.coordinator.registerIterationHook.mock.calls[0]?.[0] as
      ((payload: { state: LoopState; iteration: LoopIteration }) => void) | undefined;
    const state = makeLoopState({ status: 'running', endedAt: null });
    const iteration = makeLoopIteration({ loopRunId: state.id });

    iterationHook?.({ state, iteration });

    expect(hoisted.store.persistIterationSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      state,
      iteration,
      checkpoint: expect.objectContaining({
        loopRunId: state.id,
        historyTail: [iteration],
      }),
    }));
  });

  it('persists a checkpoint before a child iteration is invoked', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const preIterationHook = hoisted.coordinator.registerPreIterationHook.mock.calls[0]?.[0] as
      ((payload: { state: LoopState }) => void) | undefined;
    const state = makeLoopState({
      status: 'running',
      endedAt: null,
      inFlightIteration: {
        seq: 3,
        stage: 'IMPLEMENT',
        startedAt: 1_700_000_000_000,
        idempotencyKey: 'loop-1:iteration:3',
      },
    });

    preIterationHook?.({ state });

    expect(hoisted.store.persistStateCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      state,
      checkpoint: expect.objectContaining({
        loopRunId: state.id,
        status: 'running',
        state: expect.objectContaining({
          inFlightIteration: state.inFlightIteration,
        }),
        historyTail: [],
      }),
    }));
  });

  it('records a forked-session iteration as an assistant turn in the chat ledger (close-the-write-gap)', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    hoisted.chatService.appendSystemEvent.mockResolvedValue(undefined);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const iterationHook = hoisted.coordinator.registerIterationHook.mock.calls[0]?.[0] as
      ((payload: { state: LoopState; iteration: LoopIteration }) => void) | undefined;
    const state = makeLoopState({ status: 'running', endedAt: null });
    const iteration = makeLoopIteration({
      loopRunId: state.id,
      seq: 4,
      outputFull: 'Refactored the resolver and added coverage.',
      transcriptBound: false,
    });

    iterationHook?.({ state, iteration });

    expect(hoisted.chatService.appendSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        nativeMessageId: 'loop-iter:loop-1:4',
        nativeTurnId: 'loop:loop-1',
        role: 'assistant',
        phase: 'loop_iteration',
        content: 'Refactored the resolver and added coverage.',
      }),
    );
  });

  it('does not double-record a borrowed-adapter iteration (its stream already entered the transcript)', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const iterationHook = hoisted.coordinator.registerIterationHook.mock.calls[0]?.[0] as
      ((payload: { state: LoopState; iteration: LoopIteration }) => void) | undefined;
    const state = makeLoopState({ status: 'running', endedAt: null });
    const iteration = makeLoopIteration({
      loopRunId: state.id,
      seq: 1,
      outputFull: 'Already streamed into the borrowed instance transcript.',
      transcriptBound: true,
    });

    iterationHook?.({ state, iteration });

    expect(hoisted.chatService.appendSystemEvent).not.toHaveBeenCalled();
  });

  it('skips iterations that produced no text (nothing to remember)', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const iterationHook = hoisted.coordinator.registerIterationHook.mock.calls[0]?.[0] as
      ((payload: { state: LoopState; iteration: LoopIteration }) => void) | undefined;
    const state = makeLoopState({ status: 'running', endedAt: null });
    const iteration = makeLoopIteration({ loopRunId: state.id, outputFull: '', outputExcerpt: '' });

    iterationHook?.({ state, iteration });

    expect(hoisted.chatService.appendSystemEvent).not.toHaveBeenCalled();
  });

  it('records a forked-session iteration into the instance buffer for instance-detail loops', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const emitSystemMessage = vi.fn();
    const instanceManager = makeInstanceManager([], {
      getInstance: vi.fn(() => ({ id: 'inst-1', outputBuffer: [] })),
      emitSystemMessage,
    });
    // state.chatId is an instance id here, so it is not a chat.
    hoisted.chatService.tryGetChat.mockReturnValue(null);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const iterationHook = hoisted.coordinator.registerIterationHook.mock.calls[0]?.[0] as
      ((payload: { state: LoopState; iteration: LoopIteration }) => void) | undefined;
    const state = makeLoopState({ status: 'running', endedAt: null });
    const iteration = makeLoopIteration({
      loopRunId: state.id,
      seq: 2,
      outputFull: 'Forked Codex iteration output.',
      transcriptBound: false,
    });

    iterationHook?.({ state, iteration });

    expect(hoisted.chatService.appendSystemEvent).not.toHaveBeenCalled();
    expect(emitSystemMessage).toHaveBeenCalledWith(
      'chat-1',
      'Forked Codex iteration output.',
      expect.objectContaining({ kind: 'loop-iteration', loopRunId: 'loop-1', iterationSeq: 2 }),
    );
  });

  it('does not overwrite the latest checkpoint history tail on the state change emitted after an iteration', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const iterationHook = hoisted.coordinator.registerIterationHook.mock.calls[0]?.[0] as
      ((payload: { state: LoopState; iteration: LoopIteration }) => void) | undefined;
    const stateHandler = hoisted.coordinator.on.mock.calls.find((call) =>
      call[0] === 'loop:state-changed'
    )?.[1] as ((data: { loopRunId: string; state: LoopState }) => void) | undefined;
    const iteration = makeLoopIteration({ loopRunId: 'loop-1', seq: 7 });
    const state = makeLoopState({
      status: 'running',
      endedAt: null,
      lastIteration: iteration,
    });

    iterationHook?.({ state, iteration });
    stateHandler?.({ loopRunId: state.id, state });

    expect(hoisted.store.persistStateCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      state,
      checkpoint: expect.objectContaining({
        loopRunId: state.id,
        historyTail: [iteration],
      }),
    }));
  });

  it('refreshes the last iteration row on state change so post-hook audit fields persist', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const stateHandler = hoisted.coordinator.on.mock.calls.find((call) =>
      call[0] === 'loop:state-changed'
    )?.[1] as ((data: { loopRunId: string; state: LoopState }) => void) | undefined;
    const iteration = makeLoopIteration({
      loopRunId: 'loop-1',
      seq: 8,
      finalAudit: {
        status: 'needs-review',
        ranAt: 1_700_000_002_000,
        coverage: {
          criteriaTotal: 1,
          criteriaVerified: 0,
          criteriaUnverified: 1,
          verifyCommandRan: false,
          repoComparisonRan: true,
          cleanlinessScanRan: true,
        },
        findings: [{
          severity: 'review',
          code: 'plan-criteria-unproven',
          message: 'Evidence needs operator review.',
        }],
        changedFiles: ['ROADMAP.md'],
      },
    });
    const state = makeLoopState({
      status: 'completed-needs-review',
      lastIteration: iteration,
    });

    stateHandler?.({ loopRunId: state.id, state });

    expect(hoisted.store.insertIteration).toHaveBeenCalledWith(iteration);
  });

  it('fails closed when the commit ratchet hook fails', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    hoisted.loopCommitRatchetHook.mockRejectedValueOnce(new Error('git reset failed'));
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const iterationHook = hoisted.coordinator.registerIterationHook.mock.calls[0]?.[0] as
      ((payload: { state: LoopState; iteration: LoopIteration }) => Promise<void>) | undefined;
    const state = makeLoopState({ status: 'running', endedAt: null });
    const iteration = makeLoopIteration({ loopRunId: state.id, seq: 2 });

    await iterationHook?.({ state, iteration });

    expect(hoisted.coordinator.failLoop).toHaveBeenCalledWith(
      state.id,
      expect.stringContaining('Loop commit ratchet failed: git reset failed'),
    );
  });

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

    expect(hoisted.store.persistStateCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ state }));
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

  it('appends a durable chat summary when a provider-limit loop cannot auto-resume', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const state = makeLoopState({
      status: 'provider-limit',
      endReason: 'provider limit reached without a reset window',
    });
    const stateHandler = hoisted.coordinator.on.mock.calls.find((call) =>
      call[0] === 'loop:state-changed'
    )?.[1] as ((data: { loopRunId: string; state: LoopState }) => void) | undefined;

    stateHandler?.({ loopRunId: state.id, state });

    expect(hoisted.chatService.appendSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        nativeMessageId: 'loop-summary:loop-1',
        content: expect.stringContaining('Loop ended - provider-limit'),
      }),
    );
  });

  it('does not append a chat summary for a restored resumable provider-limit checkpoint', () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const state = makeLoopState({
      status: 'provider-limit',
      endedAt: null,
      endReason: 'provider window exhausted',
    });
    const stateHandler = hoisted.coordinator.on.mock.calls.find((call) =>
      call[0] === 'loop:state-changed'
    )?.[1] as ((data: { loopRunId: string; state: LoopState }) => void) | undefined;

    stateHandler?.({ loopRunId: state.id, state });

    expect(hoisted.chatService.appendSystemEvent).not.toHaveBeenCalled();
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
      config: {
        initialPrompt: 'Build the thing.',
        workspaceCwd: '/work/project',
        completion: {
          ...defaultLoopConfig('/work/project', 'Build the thing.').completion,
          verifyCommand: 'true',
        },
      },
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

  it('keeps the legacy gated fresh-eyes cross-model authority when a blank-verify config explicitly carries gated mode', async () => {
    // A blank verify command no longer triggers workspace inference of a
    // machine verify command (e.g. `npm run verify`), nor does it reject the
    // start up front. This payload carries defaultLoopConfig's explicit
    // engine-level `gated` mode, so prepareLoopStartConfig preserves that
    // legacy mode and supplies the cross-model gate. The user-started
    // review-driven default matrix lives in loop-start-config.spec.ts.
    tempWorkspace = mkdtempSync(join(tmpdir(), 'loop-handler-verify-'));
    writeFileSync(
      join(tempWorkspace, 'package.json'),
      JSON.stringify({ scripts: { verify: 'npm test' } }, null, 2),
    );
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    const startState = makeLoopState({ status: 'running', endedAt: null });
    hoisted.coordinator.startLoop.mockResolvedValue(startState);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_START);
    const payload = {
      chatId: 'chat-1',
      config: {
        initialPrompt: 'Build the thing.',
        workspaceCwd: tempWorkspace,
        // WS6: a blank-verify IMPLEMENTATION start is now rejected up front;
        // this test's subject is legacy gated-mode preservation, so give it
        // the investigation authority (mirrors loop-start-config.spec.ts).
        goalIntent: 'investigation',
        completion: {
          ...defaultLoopConfig(tempWorkspace, 'Build the thing.').completion,
          verifyCommand: '',
        },
      },
    };

    const response = await handler({}, payload);

    expect(response).toEqual({ success: true, data: { state: startState } });
    expect(hoisted.coordinator.startLoop).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        audit: {
          finalAuditMode: 'gate',
          preflightMode: 'record',
          planPacketMode: 'prompted',
          cleanlinessScan: true,
        },
        completion: expect.objectContaining({
          verifyCommand: '',
          crossModelReview: expect.objectContaining({ enabled: true }),
        }),
      }),
      undefined,
      expect.any(Object),
    );
  });

  it('allows explicit operator-reviewed completion without a verify command', async () => {
    tempWorkspace = mkdtempSync(join(tmpdir(), 'loop-handler-verify-'));
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    const startState = makeLoopState({ status: 'running', endedAt: null });
    hoisted.coordinator.startLoop.mockResolvedValue(startState);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_START);
    const payload = {
      chatId: 'chat-1',
      config: {
        initialPrompt: 'Build the thing.',
        workspaceCwd: tempWorkspace,
        completion: {
          ...defaultLoopConfig(tempWorkspace, 'Build the thing.').completion,
          verifyCommand: '',
          allowOperatorReviewedCompletion: true,
        },
      },
    };

    const response = await handler({}, payload);

    expect(response).toEqual({ success: true, data: { state: startState } });
    expect(hoisted.coordinator.startLoop).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        completion: expect.objectContaining({
          verifyCommand: '',
          allowOperatorReviewedCompletion: true,
        }),
      }),
      undefined,
      expect.any(Object),
    );
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

    // Task 18: the handler now forwards an explicit kind (default 'queue') + optional drainMode.
    expect(hoisted.coordinator.intervene).toHaveBeenCalledWith(state.id, 'try a different angle', 'queue', undefined);
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

describe('LOOP_RESUME handler', () => {
  it('restores a paused stored loop from checkpoint when LOOP_RESUME has no live coordinator state', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    const state = makeLoopState({ id: 'loop-stored', status: 'paused', endedAt: null });
    const checkpoint = {
      version: 1 as const,
      loopRunId: state.id,
      chatId: state.chatId,
      status: state.status,
      state,
      historyTail: [],
      convergenceNote: null,
      planRegenerationCount: 0,
      pendingContextReset: false,
      updatedAt: 123,
    };
    hoisted.coordinator.resumeLoop.mockReturnValueOnce(false).mockReturnValueOnce(true);
    hoisted.coordinator.getLoop.mockReturnValueOnce(undefined).mockReturnValueOnce(state);
    hoisted.coordinator.restoreLoopFromCheckpoint.mockResolvedValue(state);
    hoisted.store.getCheckpoint.mockReturnValue(checkpoint);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_RESUME);

    const response = await handler({}, { loopRunId: 'loop-stored' });

    expect(hoisted.coordinator.restoreLoopFromCheckpoint).toHaveBeenCalledWith(checkpoint);
    expect(response.success).toBe(true);
    expect(response.data).toEqual({ ok: true, state });
  });
});

describe('LOOP_RESUME_WITH_ANSWERS handler', () => {
  it('prepares fallback resumed runs with normal user-start audit and review-driven defaults', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    const startState = makeLoopState({ status: 'running', endedAt: null });
    hoisted.coordinator.startLoop.mockResolvedValue(startState);
    hoisted.store.getRunConfig.mockReturnValue(null);
    hoisted.store.listOutstandingItems.mockReturnValue([
      {
        id: 'out-1',
        loopRunId: 'missing-run',
        chatId: 'chat-1',
        workspaceCwd: '/work/project',
        kind: 'open-question',
        status: 'open',
        text: 'Which storage backend should be used?',
        userResponse: 'Use SQLite.',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_RESUME_WITH_ANSWERS);

    const response = await handler({}, {
      chatId: 'chat-1',
      workspaceCwd: '/work/project',
    });

    expect(response.success).toBe(true);
    expect(hoisted.coordinator.startLoop).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        workspaceCwd: '/work/project',
        planFile: undefined,
        audit: {
          finalAuditMode: 'gate',
          preflightMode: 'record',
          planPacketMode: 'prompted',
          cleanlinessScan: true,
        },
        completion: expect.objectContaining({
          mode: 'review-driven',
          requireCompletedFileRename: false,
        }),
      }),
      undefined,
      expect.any(Object),
    );
  });

  it('only consumes answered outstanding items from the requested workspace', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    const startState = makeLoopState({ status: 'running', endedAt: null });
    hoisted.coordinator.startLoop.mockResolvedValue(startState);
    hoisted.store.getRunConfig.mockReturnValue(null);
    hoisted.store.listOutstandingItems.mockReturnValue([
      {
        id: 'out-target',
        loopRunId: 'loop-target',
        chatId: 'chat-1',
        workspaceCwd: '/repo/target',
        kind: 'needs-human',
        status: 'open',
        text: 'Which rollout path should target use?',
        userResponse: 'Use staged rollout.',
        createdAt: 2,
        updatedAt: 2,
      },
    ]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_RESUME_WITH_ANSWERS);

    const response = await handler({}, {
      chatId: 'chat-1',
      workspaceCwd: '/repo/target',
    });

    expect(response.success).toBe(true);
    expect(hoisted.store.listOutstandingItems).toHaveBeenCalledWith({
      chatId: 'chat-1',
      workspaceCwd: '/repo/target',
      status: 'open',
    });
  });

  it('drops stale per-run worktree paths when reusing a source run config', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    const startState = makeLoopState({ status: 'running', endedAt: null });
    const sourceConfig = {
      ...defaultLoopConfig('/repo/root', 'Original goal'),
      isolateLoopWorkspaces: true,
      executionCwd: '/repo/root/.worktrees/loop-old',
      worktreeBranch: 'loop/old',
    };
    hoisted.coordinator.startLoop.mockResolvedValue(startState);
    hoisted.store.getRunConfig.mockReturnValue(sourceConfig);
    hoisted.store.listOutstandingItems.mockReturnValue([
      {
        id: 'out-1',
        loopRunId: 'loop-old',
        chatId: 'chat-1',
        workspaceCwd: '/repo/root',
        kind: 'needs-human',
        status: 'open',
        text: 'Need product decision.',
        userResponse: 'Proceed with the simpler flow.',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_RESUME_WITH_ANSWERS);

    const response = await handler({}, {
      chatId: 'chat-1',
      workspaceCwd: '/repo/root',
    });

    expect(response.success).toBe(true);
    expect(hoisted.coordinator.startLoop).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        isolateLoopWorkspaces: true,
        executionCwd: undefined,
        worktreeBranch: undefined,
      }),
      undefined,
      expect.any(Object),
    );
  });
});

describe('VERIFICATION_RUNS_LIST handler', () => {
  it('returns a least-privilege loop-scoped view of recorded verification executions', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    hoisted.verificationRunStore.listForLoop.mockReturnValue([{
      id: 'run-1',
      scope: 'loop',
      loopRunId: 'loop-1',
      instanceId: null,
      command: 'npm run test',
      canonicalCommand: 'npm run test',
      cwd: '/work/project',
      exitCode: 0,
      durationMs: 1_250,
      workHash: 'work-hash',
      outputRef: '/private/output.txt',
      startedAt: 123,
    }]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });

    const response = await findIpcHandler('verification-runs:list')({}, { loopRunId: 'loop-1' });

    expect(hoisted.verificationRunStore.listForLoop).toHaveBeenCalledWith('loop-1');
    expect(response).toEqual({
      success: true,
      data: {
        runs: [{
          id: 'run-1',
          scope: 'loop',
          loopRunId: 'loop-1',
          instanceId: null,
          command: 'npm run test',
          exitCode: 0,
          durationMs: 1_250,
          workHash: 'work-hash',
          startedAt: 123,
        }],
      },
    });
  });

  it('supports instance scope and rejects an ambiguous owner query', async () => {
    const windowManager = { sendToRenderer: vi.fn() };
    const instanceManager = makeInstanceManager([]);
    hoisted.verificationRunStore.listForInstance.mockReturnValue([]);
    registerLoopHandlers({
      windowManager: windowManager as never,
      instanceManager,
    });
    const handler = findIpcHandler('verification-runs:list');

    await expect(handler({}, { instanceId: 'instance-1' })).resolves.toEqual({ success: true, data: { runs: [] } });
    await expect(handler({}, { loopRunId: 'loop-1', instanceId: 'instance-1' })).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'VERIFICATION_RUNS_LIST_FAILED' }),
    }));
    expect(hoisted.verificationRunStore.listForInstance).toHaveBeenCalledWith('instance-1');
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

type IpcHandler = (event: unknown, payload: unknown) => Promise<{
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; timestamp: number };
}>;

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
    manualReviewOnly: false,
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    completionAttempts: 0,
    loopTasksLedgerResolvedAtStart: false,
    ...overrides,
  };
}

function makeLoopIteration(overrides: Partial<LoopIteration> = {}): LoopIteration {
  return {
    id: 'iteration-1',
    loopRunId: 'loop-1',
    seq: 0,
    stage: 'IMPLEMENT',
    startedAt: 1,
    endedAt: 2,
    childInstanceId: 'child-1',
    tokens: 10,
    costCents: 1,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: 'hash',
    outputSimilarityToPrev: null,
    outputExcerpt: '',
    outputFull: '',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
    ...overrides,
  };
}

describe('WS7: plan-scope assessment (LOOP_ASSESS_SCOPE + LOOP_START guard)', () => {
  const CAMPAIGN_REQUIRED_PLAN = [
    '# Plan',
    'implement one workstream per run.',
    '## WS1 — First',
    '- [ ] a',
    '## WS2 — Second',
    '- [ ] b',
  ].join('\n');

  function makeWorkspaceWithPlan(planText: string): string {
    tempWorkspace = mkdtempSync(join(tmpdir(), 'loop-scope-'));
    writeFileSync(join(tempWorkspace, 'PLAN.md'), planText);
    return tempWorkspace;
  }

  function register(): void {
    registerLoopHandlers({
      windowManager: { sendToRenderer: vi.fn() } as never,
      instanceManager: makeInstanceManager([]),
    });
  }

  function startPayload(workspaceCwd: string, extras: Record<string, unknown> = {}): unknown {
    return {
      chatId: 'chat-1',
      config: {
        initialPrompt: 'Work through the plan.',
        workspaceCwd,
        planFile: 'PLAN.md',
        completion: {
          ...defaultLoopConfig(workspaceCwd, 'x').completion,
          verifyCommand: 'true',
        },
        ...extras,
      },
    };
  }

  it('LOOP_ASSESS_SCOPE returns the assessment for a configured plan file', async () => {
    const workspace = makeWorkspaceWithPlan(CAMPAIGN_REQUIRED_PLAN);
    register();
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_ASSESS_SCOPE);

    const response = await handler({}, { workspaceCwd: workspace, planFile: 'PLAN.md' });

    expect(response.success).toBe(true);
    expect((response.data as { assessment: { disposition: string; workstreams: unknown[] } }).assessment)
      .toMatchObject({ disposition: 'campaign-required' });
  });

  it('LOOP_ASSESS_SCOPE rejects a plan path outside the workspace', async () => {
    const workspace = makeWorkspaceWithPlan('# ok');
    register();
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_ASSESS_SCOPE);

    const response = await handler({}, { workspaceCwd: workspace, planFile: '../outside.md' });

    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('inside the workspace');
  });

  it('LOOP_START refuses a campaign-required plan and never reaches the coordinator', async () => {
    const workspace = makeWorkspaceWithPlan(CAMPAIGN_REQUIRED_PLAN);
    register();
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_START);

    const response = await handler({}, startPayload(workspace));

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('LOOP_SCOPE_CAMPAIGN_REQUIRED');
    expect((response.data as { scopeAssessment: { workstreams: unknown[] } }).scopeAssessment.workstreams)
      .toHaveLength(2);
    // Start-boundary regression: no coordinator invocation after refusal.
    expect(hoisted.coordinator.startLoop).not.toHaveBeenCalled();
  });

  it('LOOP_START blocks campaign-recommended without the override and allows it with the persisted override', async () => {
    const recommendedPlan = CAMPAIGN_REQUIRED_PLAN.replace('implement one workstream per run.', '');
    const workspace = makeWorkspaceWithPlan(recommendedPlan);
    const startState = makeLoopState({ status: 'running', endedAt: null });
    hoisted.coordinator.startLoop.mockResolvedValue(startState);
    register();
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_START);

    const blocked = await handler({}, startPayload(workspace));
    expect(blocked.success).toBe(false);
    expect(blocked.error?.code).toBe('LOOP_SCOPE_CAMPAIGN_RECOMMENDED');
    expect(hoisted.coordinator.startLoop).not.toHaveBeenCalled();

    const allowed = await handler({}, startPayload(workspace, { singleLoopOverride: true }));
    expect(allowed.success).toBe(true);
    expect(hoisted.coordinator.startLoop).toHaveBeenCalledTimes(1);
  });

  it('LOOP_START with a single-loop plan starts normally', async () => {
    const workspace = makeWorkspaceWithPlan('# Small plan\n- [ ] one\n- [ ] two\n');
    const startState = makeLoopState({ status: 'running', endedAt: null });
    hoisted.coordinator.startLoop.mockResolvedValue(startState);
    register();
    const handler = findIpcHandler(IPC_CHANNELS.LOOP_START);

    const response = await handler({}, startPayload(workspace));

    expect(response.success).toBe(true);
    expect(hoisted.coordinator.startLoop).toHaveBeenCalledTimes(1);
  });
});
