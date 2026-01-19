/**
 * Memory IPC Handlers
 * Handles Memory-R1, Unified Memory, Debate, and Training operations
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { getMemoryManager } from '../memory-r1/memory-manager';
import { getUnifiedMemory } from '../memory/unified-controller';
import { getDebateCoordinator } from '../debate/debate-coordinator';
// Training handlers moved to training-ipc-handler.ts
import type {
  MemoryManagerConfig,
  MemoryManagerDecision,
  MemoryEntry,
  MemoryR1Stats,
  MemoryR1Snapshot,
  MemorySourceType,
} from '../../shared/types/memory-r1.types';
import type {
  UnifiedMemoryConfig,
  UnifiedRetrievalResult,
  UnifiedMemoryStats,
  UnifiedMemorySnapshot,
  SessionMemory,
  LearnedPattern,
  WorkflowMemory,
  StrategyMemory,
  SessionOutcome,
  MemoryType,
} from '../../shared/types/unified-memory.types';
import type { DebateConfig, DebateResult, ActiveDebate, DebateStats } from '../../shared/types/debate.types';
// Training types moved to training-ipc-handler.ts

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
    async (
      _event,
      payload: { context: string; candidateContent: string; taskId: string }
    ): Promise<MemoryManagerDecision> => {
      return memory.decideOperation(payload.context, payload.candidateContent, payload.taskId);
    }
  );

  // Execute operation
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_R1_EXECUTE_OPERATION,
    async (_event, decision: MemoryManagerDecision): Promise<MemoryEntry | null> => {
      return memory.executeOperation(decision);
    }
  );

  // Add entry directly
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_R1_ADD_ENTRY,
    async (
      _event,
      payload: {
        content: string;
        reason: string;
        sourceType?: MemorySourceType;
        sourceSessionId?: string;
      }
    ): Promise<MemoryEntry> => {
      return memory.addEntry(payload.content, payload.reason, payload.sourceType, payload.sourceSessionId);
    }
  );

  // Delete entry
  ipcMain.handle(IPC_CHANNELS.MEMORY_R1_DELETE_ENTRY, (_event, entryId: string): void => {
    memory.deleteEntry(entryId);
  });

  // Get entry
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_R1_GET_ENTRY,
    (_event, entryId: string): MemoryEntry | undefined => {
      return memory.getEntry(entryId);
    }
  );

  // Retrieve memories
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_R1_RETRIEVE,
    async (_event, payload: { query: string; taskId: string }): Promise<MemoryEntry[]> => {
      return memory.retrieve(payload.query, payload.taskId);
    }
  );

  // Record task outcome
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_R1_RECORD_OUTCOME,
    (_event, payload: { taskId: string; success: boolean; score: number }): void => {
      memory.recordTaskOutcome(payload.taskId, payload.success, payload.score);
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
  ipcMain.handle(IPC_CHANNELS.MEMORY_R1_LOAD, async (_event, snapshot: MemoryR1Snapshot): Promise<void> => {
    return memory.load(snapshot);
  });

  // Configure
  ipcMain.handle(IPC_CHANNELS.MEMORY_R1_CONFIGURE, (_event, config: Partial<MemoryManagerConfig>): void => {
    memory.configure(config);
  });
}

// ============ Unified Memory Handlers ============

function registerUnifiedMemoryHandlers(): void {
  const unified = getUnifiedMemory();

  // Process input
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_PROCESS_INPUT,
    async (_event, payload: { input: string; sessionId: string; taskId: string }): Promise<void> => {
      return unified.processInput(payload.input, payload.sessionId, payload.taskId);
    }
  );

  // Retrieve
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RETRIEVE,
    async (
      _event,
      payload: { query: string; taskId: string; options?: { types?: MemoryType[]; maxTokens?: number } }
    ): Promise<UnifiedRetrievalResult> => {
      return unified.retrieve(payload.query, payload.taskId, payload.options);
    }
  );

  // Record session end
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_SESSION_END,
    async (
      _event,
      payload: { sessionId: string; outcome: SessionOutcome; summary: string; lessons: string[] }
    ): Promise<void> => {
      return unified.recordSessionEnd(payload.sessionId, payload.outcome, payload.summary, payload.lessons);
    }
  );

  // Record workflow
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_WORKFLOW,
    async (
      _event,
      payload: { name: string; steps: string[]; applicableContexts: string[] }
    ): Promise<WorkflowMemory> => {
      return unified.recordWorkflow(payload.name, payload.steps, payload.applicableContexts);
    }
  );

  // Record strategy
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_STRATEGY,
    async (
      _event,
      payload: { strategy: string; conditions: string[]; taskId: string; success: boolean; score: number }
    ): Promise<StrategyMemory> => {
      return unified.recordStrategy(
        payload.strategy,
        payload.conditions,
        payload.taskId,
        payload.success,
        payload.score
      );
    }
  );

  // Record task outcome
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_RECORD_OUTCOME,
    (_event, payload: { taskId: string; success: boolean; score: number }): void => {
      unified.recordTaskOutcome(payload.taskId, payload.success, payload.score);
    }
  );

  // Get stats
  ipcMain.handle(IPC_CHANNELS.UNIFIED_MEMORY_GET_STATS, (): UnifiedMemoryStats => {
    return unified.getStats();
  });

  // Get sessions
  ipcMain.handle(IPC_CHANNELS.UNIFIED_MEMORY_GET_SESSIONS, (_event, limit?: number): SessionMemory[] => {
    return unified.getSessionHistory(limit);
  });

  // Get patterns
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_GET_PATTERNS,
    (_event, minSuccessRate?: number): LearnedPattern[] => {
      return unified.getPatterns(minSuccessRate);
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
    async (_event, snapshot: UnifiedMemorySnapshot): Promise<void> => {
      return unified.load(snapshot);
    }
  );

  // Configure
  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_MEMORY_CONFIGURE,
    (_event, config: Partial<UnifiedMemoryConfig>): void => {
      unified.configure(config);
    }
  );
}

// ============ Debate Handlers ============

function registerDebateHandlers(): void {
  const debate = getDebateCoordinator();

  // Start debate
  ipcMain.handle(
    IPC_CHANNELS.DEBATE_START,
    async (
      _event,
      payload: { query: string; context?: string; config?: Partial<DebateConfig> }
    ): Promise<string> => {
      return debate.startDebate(payload.query, payload.context, payload.config);
    }
  );

  // Get result
  ipcMain.handle(
    IPC_CHANNELS.DEBATE_GET_RESULT,
    (_event, debateId: string): DebateResult | undefined => {
      return debate.getResult(debateId);
    }
  );

  // Get active debates
  ipcMain.handle(IPC_CHANNELS.DEBATE_GET_ACTIVE, (): ActiveDebate[] => {
    return debate.getActiveDebates();
  });

  // Cancel debate
  ipcMain.handle(IPC_CHANNELS.DEBATE_CANCEL, async (_event, debateId: string): Promise<boolean> => {
    return debate.cancelDebate(debateId);
  });

  // Get stats
  ipcMain.handle(IPC_CHANNELS.DEBATE_GET_STATS, (): DebateStats => {
    return debate.getStats();
  });
}

// Note: Training handlers (GRPO) are now registered in training-ipc-handler.ts
