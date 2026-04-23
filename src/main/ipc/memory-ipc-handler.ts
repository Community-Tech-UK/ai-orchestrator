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
    async (_event, payload: unknown): Promise<MemoryManagerDecision> => {
      const validated = validateIpcPayload(
        MemoryR1DecideOperationPayloadSchema,
        payload,
        'MEMORY_R1_DECIDE_OPERATION'
      );
      return memory.decideOperation(
        validated.context,
        validated.candidateContent,
        validated.taskId
      );
    }
  );

  // Execute operation
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_R1_EXECUTE_OPERATION,
    async (_event, decision: unknown): Promise<MemoryEntry | null> => {
      const validated = validateIpcPayload(
        MemoryR1ExecuteOperationPayloadSchema,
        decision,
        'MEMORY_R1_EXECUTE_OPERATION'
      );
      return memory.executeOperation(validated);
    }
  );

  // Add entry directly
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_R1_ADD_ENTRY,
    async (_event, payload: unknown): Promise<MemoryEntry> => {
      const validated = validateIpcPayload(
        MemoryR1AddEntryPayloadSchema,
        payload,
        'MEMORY_R1_ADD_ENTRY'
      );
      return memory.addEntry(
        validated.content,
        validated.reason,
        validated.sourceType,
        validated.sourceSessionId
      );
    }
  );

  // Delete entry
  ipcMain.handle(IPC_CHANNELS.MEMORY_R1_DELETE_ENTRY, (_event, entryId: unknown): void => {
    const validated = validateIpcPayload(
      MemoryR1DeleteEntryPayloadSchema,
      entryId,
      'MEMORY_R1_DELETE_ENTRY'
    );
    memory.deleteEntry(validated);
  });

  // Get entry
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_R1_GET_ENTRY,
    (_event, entryId: unknown): MemoryEntry | undefined => {
      const validated = validateIpcPayload(
        MemoryR1GetEntryPayloadSchema,
        entryId,
        'MEMORY_R1_GET_ENTRY'
      );
      return memory.getEntry(validated);
    }
  );

  // Retrieve memories
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_R1_RETRIEVE,
    async (_event, payload: unknown): Promise<MemoryEntry[]> => {
      const validated = validateIpcPayload(
        MemoryR1RetrievePayloadSchema,
        payload,
        'MEMORY_R1_RETRIEVE'
      );
      return memory.retrieve(validated.query, validated.taskId);
    }
  );

  // Record task outcome
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_R1_RECORD_OUTCOME,
    (_event, payload: unknown): void => {
      const validated = validateIpcPayload(
        MemoryR1RecordOutcomePayloadSchema,
        payload,
        'MEMORY_R1_RECORD_OUTCOME'
      );
      memory.recordTaskOutcome(validated.taskId, validated.success, validated.score);
    }
  );

  // Get stats
  ipcMain.handle(IPC_CHANNELS.MEMORY_R1_GET_STATS, (): MemoryR1Stats => {
    return memory.getStats();
  });

  // Save state
  ipcMain.handle(IPC_CHANNELS.MEMORY_R1_SAVE, async (): Promise<MemoryR1Snapshot> => {
    return memory.save();
  });

  // Load state
  ipcMain.handle(IPC_CHANNELS.MEMORY_R1_LOAD, async (_event, snapshot: unknown): Promise<void> => {
    const validated = validateIpcPayload(
      MemoryR1LoadPayloadSchema,
      snapshot,
      'MEMORY_R1_LOAD'
    );
    return memory.load(validated);
  });

  // Configure
  ipcMain.handle(IPC_CHANNELS.MEMORY_R1_CONFIGURE, (_event, config: unknown): void => {
    const validated = validateIpcPayload(
      MemoryR1ConfigurePayloadSchema,
      config,
      'MEMORY_R1_CONFIGURE'
    );
    memory.configure(validated);
  });
}

// ============ Unified Memory Handlers ============

function registerUnifiedMemoryHandlers(): void {
  const unified = getUnifiedMemory();

  // Process input
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_PROCESS_INPUT,
    async (_event, payload: unknown): Promise<void> => {
      const validated = validateIpcPayload(
        UnifiedMemoryProcessInputPayloadSchema,
        payload,
        'UNIFIED_MEMORY_PROCESS_INPUT'
      );
      return unified.processInput(validated.input, validated.sessionId, validated.taskId);
    }
  );

  // Retrieve
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RETRIEVE,
    async (_event, payload: unknown): Promise<UnifiedRetrievalResult> => {
      const validated = validateIpcPayload(
        UnifiedMemoryRetrievePayloadSchema,
        payload,
        'UNIFIED_MEMORY_RETRIEVE'
      );
      return unified.retrieve(validated.query, validated.taskId, validated.options);
    }
  );

  // Record session end
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_SESSION_END,
    async (_event, payload: unknown): Promise<void> => {
      const validated = validateIpcPayload(
        UnifiedMemoryRecordSessionEndPayloadSchema,
        payload,
        'UNIFIED_MEMORY_RECORD_SESSION_END'
      );
      return unified.recordSessionEnd(
        validated.sessionId,
        validated.outcome,
        validated.summary,
        validated.lessons
      );
    }
  );

  // Record workflow
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_WORKFLOW,
    async (_event, payload: unknown): Promise<WorkflowMemory> => {
      const validated = validateIpcPayload(
        UnifiedMemoryRecordWorkflowPayloadSchema,
        payload,
        'UNIFIED_MEMORY_RECORD_WORKFLOW'
      );
      return unified.recordWorkflow(
        validated.name,
        validated.steps,
        validated.applicableContexts
      );
    }
  );

  // Record strategy
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_STRATEGY,
    async (_event, payload: unknown): Promise<StrategyMemory> => {
      const validated = validateIpcPayload(
        UnifiedMemoryRecordStrategyPayloadSchema,
        payload,
        'UNIFIED_MEMORY_RECORD_STRATEGY'
      );
      return unified.recordStrategy(
        validated.strategy,
        validated.conditions,
        validated.taskId,
        validated.success,
        validated.score
      );
    }
  );

  // Record task outcome
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_OUTCOME,
    (_event, payload: unknown): void => {
      const validated = validateIpcPayload(
        UnifiedMemoryRecordOutcomePayloadSchema,
        payload,
        'UNIFIED_MEMORY_RECORD_OUTCOME'
      );
      unified.recordTaskOutcome(validated.taskId, validated.success, validated.score);
    }
  );

  // Get stats
  ipcMain.handle(IPC_CHANNELS.UNIFIED_MEMORY_GET_STATS, (): UnifiedMemoryStats => {
    return unified.getStats();
  });

  // Get sessions
  ipcMain.handle(IPC_CHANNELS.UNIFIED_MEMORY_GET_SESSIONS, (_event, limit: unknown): SessionMemory[] => {
    const validated = validateIpcPayload(
      UnifiedMemoryGetSessionsPayloadSchema,
      limit,
      'UNIFIED_MEMORY_GET_SESSIONS'
    );
    return unified.getSessionHistory(validated);
  });

  // Get patterns
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_GET_PATTERNS,
    (_event, minSuccessRate: unknown): LearnedPattern[] => {
      const validated = validateIpcPayload(
        UnifiedMemoryGetPatternsPayloadSchema,
        minSuccessRate,
        'UNIFIED_MEMORY_GET_PATTERNS'
      );
      return unified.getPatterns(validated);
    }
  );

  // Get workflows
  ipcMain.handle(IPC_CHANNELS.UNIFIED_MEMORY_GET_WORKFLOWS, (): WorkflowMemory[] => {
    return unified.getWorkflows();
  });

  // Save state
  ipcMain.handle(IPC_CHANNELS.UNIFIED_MEMORY_SAVE, async (): Promise<UnifiedMemorySnapshot> => {
    return unified.save();
  });

  // Load state
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_LOAD,
    async (_event, snapshot: unknown): Promise<void> => {
      const validated = validateIpcPayload(
        UnifiedMemoryLoadPayloadSchema,
        snapshot,
        'UNIFIED_MEMORY_LOAD'
      );
      return unified.load(validated);
    }
  );

  // Configure
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_CONFIGURE,
    (_event, config: unknown): void => {
      const validated = validateIpcPayload(
        UnifiedMemoryConfigurePayloadSchema,
        config,
        'UNIFIED_MEMORY_CONFIGURE'
      );
      unified.configure(validated);
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
