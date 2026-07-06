/**
 * Memory IPC Handlers
 * Handles Memory-R1, Unified Memory, Debate, and Training operations
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../shared/types/ipc.types';
import { isFeatureEnabled } from '../../shared/constants/feature-flags';
import { getMemoryManager } from '../memory/r1-memory-manager';
import { getUnifiedMemory } from '../memory/unified-controller';
import { getDebateCoordinator } from '../orchestration/debate-coordinator';
import { OrchestrationEventStore } from '../orchestration/event-store/orchestration-event-store';
import { getRLMDatabase } from '../persistence/rlm-database';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  DebateCancelPayloadSchema,
  DebateGetResultPayloadSchema,
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
import type {
  UnifiedRetrievalResult,
  UnifiedMemoryStats,
  UnifiedMemorySnapshot,
  SessionMemory,
  LearnedPattern,
  WorkflowMemory,
  StrategyMemory
} from '../../shared/types/unified-memory.types';
import type { DebateResult, ActiveDebate, DebateStats } from '../../shared/types/debate.types';
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
export function registerMemoryHandlers(): void {
  registerMemoryR1Handlers();
  registerUnifiedMemoryHandlers();
  registerDebateHandlers();
  // Note: Training handlers are registered separately via training-ipc-handler.ts
}

// ============ Memory-R1 Handlers ============

function registerMemoryR1Handlers(): void {
  const memory = getMemoryManager();

  // Decide operation
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(IPC_CHANNELS.MEMORY_R1_DELETE_ENTRY, (_event, entryId: unknown): IpcResponse<void> => {
    const validated = validateIpcPayload(
      MemoryR1DeleteEntryPayloadSchema,
      entryId,
      'MEMORY_R1_DELETE_ENTRY'
    );
    memory.deleteEntry(validated);
    return successVoid();
  });

  // Get entry
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(IPC_CHANNELS.MEMORY_R1_GET_STATS, (): IpcResponse<MemoryR1Stats> => {
    return success(memory.getStats());
  });

  // Save state
  ipcMain.handle(IPC_CHANNELS.MEMORY_R1_SAVE, async (): Promise<IpcResponse<MemoryR1Snapshot>> => {
    return success(await memory.save());
  });

  // Load state
  ipcMain.handle(IPC_CHANNELS.MEMORY_R1_LOAD, async (_event, snapshot: unknown): Promise<IpcResponse<void>> => {
    const validated = validateIpcPayload(
      MemoryR1LoadPayloadSchema,
      snapshot,
      'MEMORY_R1_LOAD'
    );
    await memory.load(validated);
    return successVoid();
  });

  // Configure
  ipcMain.handle(IPC_CHANNELS.MEMORY_R1_CONFIGURE, (_event, config: unknown): IpcResponse<void> => {
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

function registerUnifiedMemoryHandlers(): void {
  const unified = getUnifiedMemory();

  // Process input
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_PROCESS_INPUT,
    async (_event, payload: unknown): Promise<IpcResponse<void>> => {
      const validated = validateIpcPayload(
        UnifiedMemoryProcessInputPayloadSchema,
        payload,
        'UNIFIED_MEMORY_PROCESS_INPUT'
      );
      await unified.processInput(validated.input, validated.sessionId, validated.taskId);
      return successVoid();
    }
  );

  // Retrieve
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RETRIEVE,
    async (_event, payload: unknown): Promise<IpcResponse<UnifiedRetrievalResult>> => {
      const validated = validateIpcPayload(
        UnifiedMemoryRetrievePayloadSchema,
        payload,
        'UNIFIED_MEMORY_RETRIEVE'
      );
      return success(await unified.retrieve(validated.query, validated.taskId, validated.options));
    }
  );

  // Record session end
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_SESSION_END,
    async (_event, payload: unknown): Promise<IpcResponse<void>> => {
      const validated = validateIpcPayload(
        UnifiedMemoryRecordSessionEndPayloadSchema,
        payload,
        'UNIFIED_MEMORY_RECORD_SESSION_END'
      );
      await unified.recordSessionEnd(
        validated.sessionId,
        validated.outcome,
        validated.summary,
        validated.lessons
      );
      return successVoid();
    }
  );

  // Record workflow
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_WORKFLOW,
    async (_event, payload: unknown): Promise<IpcResponse<WorkflowMemory>> => {
      const validated = validateIpcPayload(
        UnifiedMemoryRecordWorkflowPayloadSchema,
        payload,
        'UNIFIED_MEMORY_RECORD_WORKFLOW'
      );
      const workflow = await unified.recordWorkflow(
        validated.name,
        validated.steps,
        validated.applicableContexts
      );
      return success(workflow);
    }
  );

  // Record strategy
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_STRATEGY,
    async (_event, payload: unknown): Promise<IpcResponse<StrategyMemory>> => {
      const validated = validateIpcPayload(
        UnifiedMemoryRecordStrategyPayloadSchema,
        payload,
        'UNIFIED_MEMORY_RECORD_STRATEGY'
      );
      const strategy = await unified.recordStrategy(
        validated.strategy,
        validated.conditions,
        validated.taskId,
        validated.success,
        validated.score
      );
      return success(strategy);
    }
  );

  // Record task outcome
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_OUTCOME,
    (_event, payload: unknown): IpcResponse<void> => {
      const validated = validateIpcPayload(
        UnifiedMemoryRecordOutcomePayloadSchema,
        payload,
        'UNIFIED_MEMORY_RECORD_OUTCOME'
      );
      unified.recordTaskOutcome(validated.taskId, validated.success, validated.score);
      return successVoid();
    }
  );

  // Get stats
  ipcMain.handle(IPC_CHANNELS.UNIFIED_MEMORY_GET_STATS, (): IpcResponse<UnifiedMemoryStats> => {
    return success(unified.getStats());
  });

  // Get sessions
  ipcMain.handle(IPC_CHANNELS.UNIFIED_MEMORY_GET_SESSIONS, (_event, limit: unknown): IpcResponse<SessionMemory[]> => {
    const validated = validateIpcPayload(
      UnifiedMemoryGetSessionsPayloadSchema,
      limit,
      'UNIFIED_MEMORY_GET_SESSIONS'
    );
    return success(unified.getSessionHistory(validated));
  });

  // Get patterns
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_GET_PATTERNS,
    (_event, minSuccessRate: unknown): IpcResponse<LearnedPattern[]> => {
      const validated = validateIpcPayload(
        UnifiedMemoryGetPatternsPayloadSchema,
        minSuccessRate,
        'UNIFIED_MEMORY_GET_PATTERNS'
      );
      return success(unified.getPatterns(validated));
    }
  );

  // Get workflows
  ipcMain.handle(IPC_CHANNELS.UNIFIED_MEMORY_GET_WORKFLOWS, (): IpcResponse<WorkflowMemory[]> => {
    return success(unified.getWorkflows());
  });

  // Save state
  ipcMain.handle(IPC_CHANNELS.UNIFIED_MEMORY_SAVE, async (): Promise<IpcResponse<UnifiedMemorySnapshot>> => {
    return success(await unified.save());
  });

  // Load state
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_LOAD,
    async (_event, snapshot: unknown): Promise<IpcResponse<void>> => {
      const validated = validateIpcPayload(
        UnifiedMemoryLoadPayloadSchema,
        snapshot,
        'UNIFIED_MEMORY_LOAD'
      );
      await unified.load(validated);
      return successVoid();
    }
  );

  // Configure
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_CONFIGURE,
    (_event, config: unknown): IpcResponse<void> => {
      const validated = validateIpcPayload(
        UnifiedMemoryConfigurePayloadSchema,
        config,
        'UNIFIED_MEMORY_CONFIGURE'
      );
      unified.configure(validated);
      return successVoid();
    }
  );
}

// ============ Debate Handlers ============

function registerDebateHandlers(): void {
  const debate = getDebateCoordinator();

  // Start debate
  ipcMain.handle(
    IPC_CHANNELS.DEBATE_START,
    async (_event, payload: unknown): Promise<string> => {
      const validated = validateIpcPayload(
        DebateStartPayloadSchema,
        payload,
        'DEBATE_START'
      );
      return debate.startDebate(validated.query, validated.context, validated.config, {
        instanceId: validated.instanceId,
        provider: validated.provider,
      });
    }
  );

  // Get result
  ipcMain.handle(
    IPC_CHANNELS.DEBATE_GET_RESULT,
    (_event, debateId: unknown): DebateResult | undefined => {
      const validated = validateIpcPayload(
        DebateGetResultPayloadSchema,
        debateId,
        'DEBATE_GET_RESULT'
      );
      if (isFeatureEnabled('EVENT_SOURCING')) {
        return getOrchestrationEventStore().getDebateResult(validated);
      }
      return debate.getResult(validated);
    }
  );

  // Get active debates
  ipcMain.handle(IPC_CHANNELS.DEBATE_GET_ACTIVE, (): ActiveDebate[] => {
    if (isFeatureEnabled('EVENT_SOURCING')) {
      return getOrchestrationEventStore().getActiveDebates();
    }
    return debate.getActiveDebates();
  });

  // Cancel debate
  ipcMain.handle(IPC_CHANNELS.DEBATE_CANCEL, async (_event, debateId: unknown): Promise<boolean> => {
    const validated = validateIpcPayload(
      DebateCancelPayloadSchema,
      debateId,
      'DEBATE_CANCEL'
    );
    return debate.cancelDebate(validated);
  });

  // Get stats
  ipcMain.handle(IPC_CHANNELS.DEBATE_GET_STATS, (): DebateStats => {
    return debate.getStats();
  });

  // Pause debate — frontend calls 'debate:pause'
  ipcMain.handle('debate:pause', async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const data = payload as { sessionId?: string } | undefined;
      const debateId = data?.sessionId;
      if (!debateId) {
        return { success: false, error: { code: 'INVALID_PAYLOAD', message: 'sessionId required', timestamp: Date.now() } };
      }
      return { success: debate.pauseDebate(debateId), data: { debateId, status: 'paused' } };
    } catch (error) {
      return { success: false, error: { code: 'DEBATE_PAUSE_FAILED', message: (error as Error).message, timestamp: Date.now() } };
    }
  });

  // Resume debate — frontend calls 'debate:resume'
  ipcMain.handle('debate:resume', async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const data = payload as { sessionId?: string } | undefined;
      const debateId = data?.sessionId;
      if (!debateId) {
        return { success: false, error: { code: 'INVALID_PAYLOAD', message: 'sessionId required', timestamp: Date.now() } };
      }
      return { success: debate.resumeDebate(debateId), data: { debateId, status: 'in_progress' } };
    } catch (error) {
      return { success: false, error: { code: 'DEBATE_RESUME_FAILED', message: (error as Error).message, timestamp: Date.now() } };
    }
  });

  // Stop debate — frontend calls 'debate:stop' (alias for cancel)
  ipcMain.handle('debate:stop', async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const data = payload as { sessionId?: string } | undefined;
      const debateId = data?.sessionId;
      if (!debateId) {
        return { success: false, error: { code: 'INVALID_PAYLOAD', message: 'sessionId required', timestamp: Date.now() } };
      }
      const stopped = await debate.cancelDebate(debateId);
      return { success: stopped, data: { debateId, status: 'cancelled' } };
    } catch (error) {
      return { success: false, error: { code: 'DEBATE_STOP_FAILED', message: (error as Error).message, timestamp: Date.now() } };
    }
  });

  // Intervene in debate — frontend calls 'debate:intervene'
  ipcMain.handle('debate:intervene', async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const data = payload as { sessionId?: string; message?: string } | undefined;
      const debateId = data?.sessionId;
      const message = data?.message;
      if (!debateId || !message) {
        return { success: false, error: { code: 'INVALID_PAYLOAD', message: 'sessionId and message required', timestamp: Date.now() } };
      }
      return { success: debate.intervene(debateId, message), data: { debateId } };
    } catch (error) {
      return { success: false, error: { code: 'DEBATE_INTERVENE_FAILED', message: (error as Error).message, timestamp: Date.now() } };
    }
  });
}

// Note: Training handlers (GRPO) are now registered in training-ipc-handler.ts
