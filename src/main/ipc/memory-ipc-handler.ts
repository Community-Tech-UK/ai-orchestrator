/**
 * Memory IPC Handlers
 * Handles Memory-R1, Unified Memory, Debate, and Training operations
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS, IpcResponse } from '../../shared/types/ipc.types';
import { isFeatureEnabled } from '../../shared/constants/feature-flags';
import { getMemoryManager } from '../memory/r1-memory-manager';
import { getContextWorkerClient } from '../instance/context-worker-client';
import type { UnifiedMemoryWorkerPort } from '../instance/unified-memory-worker-port';
import { getDebateCoordinator } from '../orchestration/debate-coordinator';
import { OrchestrationEventStore } from '../orchestration/event-store/orchestration-event-store';
import { getRLMDatabase } from '../persistence/rlm-database';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  DebateCancelPayloadSchema,
  DebateGetResultPayloadSchema,
  DebateIntervenePayloadSchema,
  DebateSessionActionPayloadSchema,
  DebateStartPayloadSchema,
} from '@contracts/schemas/orchestration';
import {
  MemoryR1AddEntryPayloadSchema,
  MemoryR1ConfigurePayloadSchema,
  MemoryR1DecideOperationPayloadSchema,
  MemoryR1DeleteEntryPayloadSchema,
  MemoryR1ExecuteOperationPayloadSchema,
  MemoryR1GetEntryPayloadSchema,
  MemoryR1LoadPayloadSchema,
  MemoryR1RecordOutcomePayloadSchema,
  MemoryR1RetrievePayloadSchema,
  UnifiedMemoryConfigurePayloadSchema,
  UnifiedMemoryGetPatternsPayloadSchema,
  UnifiedMemoryGetSessionsPayloadSchema,
  UnifiedMemoryLoadPayloadSchema,
  UnifiedMemoryProcessInputPayloadSchema,
  UnifiedMemoryRecordOutcomePayloadSchema,
  UnifiedMemoryRecordSessionEndPayloadSchema,
  UnifiedMemoryRecordStrategyPayloadSchema,
  UnifiedMemoryRecordWorkflowPayloadSchema,
  UnifiedMemoryRetrievePayloadSchema,
} from '@contracts/schemas/session';
// Training handlers moved to training-ipc-handler.ts
import type {
  MemoryManagerDecision,
  MemoryEntry,
  MemoryR1Stats,
  MemoryR1Snapshot
} from '../../shared/types/memory-r1.types';
import type { DebateResult, ActiveDebate, DebateStats } from '../../shared/types/debate.types';
import { validatedHandler } from './validated-handler';
// Training types moved to training-ipc-handler.ts

function success<T>(data: T): IpcResponse<T> {
  return { success: true, data };
}

function successVoid(): IpcResponse<void> {
  return { success: true };
}

function getOrchestrationEventStore(): OrchestrationEventStore {
  const store = OrchestrationEventStore.getInstance(getRLMDatabase().getRawDb());
  store.initialize();
  return store;
}

/**
 * Register all memory-related IPC handlers
 */
interface RegisterMemoryHandlersDeps {
  unifiedMemoryPort?: UnifiedMemoryWorkerPort;
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

export function registerMemoryHandlers(deps: RegisterMemoryHandlersDeps = {}): void {
  registerMemoryR1Handlers(deps);
  registerUnifiedMemoryHandlers(deps);
  registerDebateHandlers(deps);
  // Note: Training handlers are registered separately via training-ipc-handler.ts
}

// ============ Memory-R1 Handlers ============

function registerMemoryR1Handlers(deps: RegisterMemoryHandlersDeps): void {
  const memory = getMemoryManager();
  const registerMemoryHandler = createMemoryHandlerRegistrar(deps);

  // Decide operation
  registerMemoryHandler(
    IPC_CHANNELS.MEMORY_R1_DECIDE_OPERATION,
    async (_event, payload: unknown): Promise<IpcResponse<MemoryManagerDecision>> => {
      const validated = validateIpcPayload(
        MemoryR1DecideOperationPayloadSchema,
        payload,
        'MEMORY_R1_DECIDE_OPERATION'
      );
      const decision = await memory.decideOperation(
        validated.context,
        validated.candidateContent,
        validated.taskId
      );
      return success(decision);
    }
  );

  // Execute operation
  registerMemoryHandler(
    IPC_CHANNELS.MEMORY_R1_EXECUTE_OPERATION,
    async (_event, decision: unknown): Promise<IpcResponse<MemoryEntry | null>> => {
      const validated = validateIpcPayload(
        MemoryR1ExecuteOperationPayloadSchema,
        decision,
        'MEMORY_R1_EXECUTE_OPERATION'
      );
      return success(await memory.executeOperation(validated));
    }
  );

  // Add entry directly
  registerMemoryHandler(
    IPC_CHANNELS.MEMORY_R1_ADD_ENTRY,
    async (_event, payload: unknown): Promise<IpcResponse<MemoryEntry>> => {
      const validated = validateIpcPayload(
        MemoryR1AddEntryPayloadSchema,
        payload,
        'MEMORY_R1_ADD_ENTRY'
      );
      const entry = await memory.addEntry(
        validated.content,
        validated.reason,
        validated.sourceType,
        validated.sourceSessionId
      );
      return success(entry);
    }
  );

  // Delete entry
  registerMemoryHandler(IPC_CHANNELS.MEMORY_R1_DELETE_ENTRY, (_event, entryId: unknown): IpcResponse<void> => {
    const validated = validateIpcPayload(
      MemoryR1DeleteEntryPayloadSchema,
      entryId,
      'MEMORY_R1_DELETE_ENTRY'
    );
    memory.deleteEntry(validated);
    return successVoid();
  });

  // Get entry
  registerMemoryHandler(
    IPC_CHANNELS.MEMORY_R1_GET_ENTRY,
    (_event, entryId: unknown): IpcResponse<MemoryEntry | undefined> => {
      const validated = validateIpcPayload(
        MemoryR1GetEntryPayloadSchema,
        entryId,
        'MEMORY_R1_GET_ENTRY'
      );
      return success(memory.getEntry(validated));
    }
  );

  // Retrieve memories
  registerMemoryHandler(
    IPC_CHANNELS.MEMORY_R1_RETRIEVE,
    async (_event, payload: unknown): Promise<IpcResponse<MemoryEntry[]>> => {
      const validated = validateIpcPayload(
        MemoryR1RetrievePayloadSchema,
        payload,
        'MEMORY_R1_RETRIEVE'
      );
      return success(await memory.retrieve(validated.query, validated.taskId));
    }
  );

  // Record task outcome
  registerMemoryHandler(
    IPC_CHANNELS.MEMORY_R1_RECORD_OUTCOME,
    (_event, payload: unknown): IpcResponse<void> => {
      const validated = validateIpcPayload(
        MemoryR1RecordOutcomePayloadSchema,
        payload,
        'MEMORY_R1_RECORD_OUTCOME'
      );
      memory.recordTaskOutcome(validated.taskId, validated.success, validated.score);
      return successVoid();
    }
  );

  // Get stats
  registerMemoryHandler(IPC_CHANNELS.MEMORY_R1_GET_STATS, (): IpcResponse<MemoryR1Stats> => {
    return success(memory.getStats());
  });

  // Save state
  registerMemoryHandler(IPC_CHANNELS.MEMORY_R1_SAVE, async (): Promise<IpcResponse<MemoryR1Snapshot>> => {
    return success(await memory.save());
  });

  // Load state
  registerMemoryHandler(IPC_CHANNELS.MEMORY_R1_LOAD, async (_event, snapshot: unknown): Promise<IpcResponse<void>> => {
    const validated = validateIpcPayload(
      MemoryR1LoadPayloadSchema,
      snapshot,
      'MEMORY_R1_LOAD'
    );
    await memory.load(validated);
    return successVoid();
  });

  // Configure
  registerMemoryHandler(IPC_CHANNELS.MEMORY_R1_CONFIGURE, (_event, config: unknown): IpcResponse<void> => {
    const validated = validateIpcPayload(
      MemoryR1ConfigurePayloadSchema,
      config,
      'MEMORY_R1_CONFIGURE'
    );
    memory.configure(validated);
    return successVoid();
  });
}

// ============ Unified Memory Handlers ============

function registerUnifiedMemoryHandlers(deps: RegisterMemoryHandlersDeps): void {
  const unifiedMemoryPort = deps.unifiedMemoryPort ?? getContextWorkerClient();
  const registerMemoryHandler = createMemoryHandlerRegistrar(deps);

  // Process input
  registerMemoryHandler(
    IPC_CHANNELS.UNIFIED_MEMORY_PROCESS_INPUT,
    async (_event, payload: unknown): Promise<IpcResponse<void>> => {
      const validated = validateIpcPayload(
        UnifiedMemoryProcessInputPayloadSchema,
        payload,
        'UNIFIED_MEMORY_PROCESS_INPUT'
      );
      await unifiedMemoryPort.invokeUnifiedMemory({
        kind: 'process-input',
        input: validated.input,
        sessionId: validated.sessionId,
        taskId: validated.taskId,
      });
      return successVoid();
    }
  );

  // Retrieve
  registerMemoryHandler(
    IPC_CHANNELS.UNIFIED_MEMORY_RETRIEVE,
    async (_event, payload: unknown) => {
      const validated = validateIpcPayload(
        UnifiedMemoryRetrievePayloadSchema,
        payload,
        'UNIFIED_MEMORY_RETRIEVE'
      );
      return success(await unifiedMemoryPort.invokeUnifiedMemory({
        kind: 'retrieve',
        query: validated.query,
        taskId: validated.taskId,
        options: validated.options,
      }));
    }
  );

  // Record session end
  registerMemoryHandler(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_SESSION_END,
    async (_event, payload: unknown): Promise<IpcResponse<void>> => {
      const validated = validateIpcPayload(
        UnifiedMemoryRecordSessionEndPayloadSchema,
        payload,
        'UNIFIED_MEMORY_RECORD_SESSION_END'
      );
      await unifiedMemoryPort.invokeUnifiedMemory({
        kind: 'record-session-end',
        sessionId: validated.sessionId,
        outcome: validated.outcome,
        summary: validated.summary,
        lessons: validated.lessons,
      });
      return successVoid();
    }
  );

  // Record workflow
  registerMemoryHandler(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_WORKFLOW,
    async (_event, payload: unknown) => {
      const validated = validateIpcPayload(
        UnifiedMemoryRecordWorkflowPayloadSchema,
        payload,
        'UNIFIED_MEMORY_RECORD_WORKFLOW'
      );
      const workflow = await unifiedMemoryPort.invokeUnifiedMemory({
        kind: 'record-workflow',
        name: validated.name,
        steps: validated.steps,
        applicableContexts: validated.applicableContexts,
      });
      return success(workflow);
    }
  );

  // Record strategy
  registerMemoryHandler(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_STRATEGY,
    async (_event, payload: unknown) => {
      const validated = validateIpcPayload(
        UnifiedMemoryRecordStrategyPayloadSchema,
        payload,
        'UNIFIED_MEMORY_RECORD_STRATEGY'
      );
      const strategy = await unifiedMemoryPort.invokeUnifiedMemory({
        kind: 'record-strategy',
        strategy: validated.strategy,
        conditions: validated.conditions,
        taskId: validated.taskId,
        success: validated.success,
        score: validated.score,
      });
      return success(strategy);
    }
  );

  // Record task outcome
  registerMemoryHandler(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_OUTCOME,
    async (_event, payload: unknown): Promise<IpcResponse<void>> => {
      const validated = validateIpcPayload(
        UnifiedMemoryRecordOutcomePayloadSchema,
        payload,
        'UNIFIED_MEMORY_RECORD_OUTCOME'
      );
      await unifiedMemoryPort.invokeUnifiedMemory({
        kind: 'record-outcome',
        taskId: validated.taskId,
        success: validated.success,
        score: validated.score,
      });
      return successVoid();
    }
  );

  // Get stats
  registerMemoryHandler(IPC_CHANNELS.UNIFIED_MEMORY_GET_STATS, async () => {
    return success(await unifiedMemoryPort.invokeUnifiedMemory({ kind: 'get-stats' }));
  });

  // Get sessions
  registerMemoryHandler(IPC_CHANNELS.UNIFIED_MEMORY_GET_SESSIONS, async (_event, limit: unknown) => {
    const validated = validateIpcPayload(
      UnifiedMemoryGetSessionsPayloadSchema,
      limit,
      'UNIFIED_MEMORY_GET_SESSIONS'
    );
    return success(await unifiedMemoryPort.invokeUnifiedMemory({
      kind: 'get-sessions',
      limit: validated,
    }));
  });

  // Get patterns
  registerMemoryHandler(
    IPC_CHANNELS.UNIFIED_MEMORY_GET_PATTERNS,
    async (_event, minSuccessRate: unknown) => {
      const validated = validateIpcPayload(
        UnifiedMemoryGetPatternsPayloadSchema,
        minSuccessRate,
        'UNIFIED_MEMORY_GET_PATTERNS'
      );
      return success(await unifiedMemoryPort.invokeUnifiedMemory({
        kind: 'get-patterns',
        minSuccessRate: validated,
      }));
    }
  );

  // Get workflows
  registerMemoryHandler(IPC_CHANNELS.UNIFIED_MEMORY_GET_WORKFLOWS, async () => {
    return success(await unifiedMemoryPort.invokeUnifiedMemory({ kind: 'get-workflows' }));
  });

  // Save state
  registerMemoryHandler(IPC_CHANNELS.UNIFIED_MEMORY_SAVE, async () => {
    return success(await unifiedMemoryPort.invokeUnifiedMemory({ kind: 'save' }));
  });

  // Load state
  registerMemoryHandler(
    IPC_CHANNELS.UNIFIED_MEMORY_LOAD,
    async (_event, snapshot: unknown): Promise<IpcResponse<void>> => {
      const validated = validateIpcPayload(
        UnifiedMemoryLoadPayloadSchema,
        snapshot,
        'UNIFIED_MEMORY_LOAD'
      );
      await unifiedMemoryPort.invokeUnifiedMemory({ kind: 'load', snapshot: validated });
      return successVoid();
    }
  );

  // Configure
  registerMemoryHandler(
    IPC_CHANNELS.UNIFIED_MEMORY_CONFIGURE,
    async (_event, config: unknown): Promise<IpcResponse<void>> => {
      const validated = validateIpcPayload(
        UnifiedMemoryConfigurePayloadSchema,
        config,
        'UNIFIED_MEMORY_CONFIGURE'
      );
      await unifiedMemoryPort.invokeUnifiedMemory({ kind: 'configure', config: validated });
      return successVoid();
    }
  );
}

// ============ Debate Handlers ============

function registerDebateHandlers(deps: RegisterMemoryHandlersDeps): void {
  const debate = getDebateCoordinator();
  const emptyPayloadSchema = z.undefined().optional();
  const options = (errorCode: string) => ({
    ensureTrustedSender: deps.ensureTrustedSender,
    errorCode,
  });

  // Start debate
  ipcMain.handle(
    IPC_CHANNELS.DEBATE_START,
    validatedHandler(
      IPC_CHANNELS.DEBATE_START,
      DebateStartPayloadSchema,
      async (payload) => success(await debate.startDebate(
        payload.query,
        payload.context,
        payload.config,
        { instanceId: payload.instanceId, provider: payload.provider },
      )),
      options('DEBATE_START_FAILED'),
    ),
  );

  // Get result
  ipcMain.handle(
    IPC_CHANNELS.DEBATE_GET_RESULT,
    validatedHandler(
      IPC_CHANNELS.DEBATE_GET_RESULT,
      DebateGetResultPayloadSchema,
      async (debateId) => success(isFeatureEnabled('EVENT_SOURCING')
        ? getOrchestrationEventStore().getDebateResult(debateId)
        : debate.getResult(debateId)),
      options('DEBATE_GET_RESULT_FAILED'),
    ),
  );

  // Get active debates
  ipcMain.handle(
    IPC_CHANNELS.DEBATE_GET_ACTIVE,
    validatedHandler(
      IPC_CHANNELS.DEBATE_GET_ACTIVE,
      emptyPayloadSchema,
      async () => success<ActiveDebate[]>(isFeatureEnabled('EVENT_SOURCING')
        ? getOrchestrationEventStore().getActiveDebates()
        : debate.getActiveDebates()),
      options('DEBATE_GET_ACTIVE_FAILED'),
    ),
  );

  // Cancel debate
  ipcMain.handle(
    IPC_CHANNELS.DEBATE_CANCEL,
    validatedHandler(
      IPC_CHANNELS.DEBATE_CANCEL,
      DebateCancelPayloadSchema,
      async (debateId) => success(await debate.cancelDebate(debateId)),
      options('DEBATE_CANCEL_FAILED'),
    ),
  );

  // Get stats
  ipcMain.handle(
    IPC_CHANNELS.DEBATE_GET_STATS,
    validatedHandler(
      IPC_CHANNELS.DEBATE_GET_STATS,
      emptyPayloadSchema,
      async () => success<DebateStats>(debate.getStats()),
      options('DEBATE_GET_STATS_FAILED'),
    ),
  );

  // Pause debate
  ipcMain.handle(
    IPC_CHANNELS.DEBATE_PAUSE,
    validatedHandler(
      IPC_CHANNELS.DEBATE_PAUSE,
      DebateSessionActionPayloadSchema,
      async ({ sessionId }) => success({
        debateId: sessionId,
        status: 'paused' as const,
        paused: debate.pauseDebate(sessionId),
      }),
      options('DEBATE_PAUSE_FAILED'),
    ),
  );

  // Resume debate
  ipcMain.handle(
    IPC_CHANNELS.DEBATE_RESUME,
    validatedHandler(
      IPC_CHANNELS.DEBATE_RESUME,
      DebateSessionActionPayloadSchema,
      async ({ sessionId }) => success({
        debateId: sessionId,
        status: 'in_progress' as const,
        resumed: debate.resumeDebate(sessionId),
      }),
      options('DEBATE_RESUME_FAILED'),
    ),
  );

  // Stop debate (alias for cancel)
  ipcMain.handle(
    IPC_CHANNELS.DEBATE_STOP,
    validatedHandler(
      IPC_CHANNELS.DEBATE_STOP,
      DebateSessionActionPayloadSchema,
      async ({ sessionId }) => success({
        debateId: sessionId,
        status: 'cancelled' as const,
        stopped: await debate.cancelDebate(sessionId),
      }),
      options('DEBATE_STOP_FAILED'),
    ),
  );

  // Intervene in debate
  ipcMain.handle(
    IPC_CHANNELS.DEBATE_INTERVENE,
    validatedHandler(
      IPC_CHANNELS.DEBATE_INTERVENE,
      DebateIntervenePayloadSchema,
      async ({ sessionId, message }) => success({
        debateId: sessionId,
        accepted: debate.intervene(sessionId, message),
      }),
      options('DEBATE_INTERVENE_FAILED'),
    ),
  );
}

type MemoryHandler = (
  event: IpcMainInvokeEvent,
  payload: unknown,
) => IpcResponse<unknown> | Promise<IpcResponse<unknown>>;

function createMemoryHandlerRegistrar(deps: RegisterMemoryHandlersDeps) {
  return (channel: string, handler: MemoryHandler): void => {
    ipcMain.handle(channel, async (event, payload): Promise<IpcResponse> => {
      const trustError = deps.ensureTrustedSender?.(event, channel);
      if (trustError) {
        return trustError;
      }
      try {
        return await handler(event, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const validationFailed = message.startsWith('IPC validation failed for ');
        return {
          success: false,
          error: {
            code: validationFailed
              ? 'VALIDATION_FAILED'
              : `${channel.replace(/[:-]/g, '_').toUpperCase()}_FAILED`,
            message,
            timestamp: Date.now(),
          },
        };
      }
    });
  };
}

// Note: Training handlers (GRPO) are now registered in training-ipc-handler.ts
