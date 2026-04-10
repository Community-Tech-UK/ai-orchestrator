import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createMemoryDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    // ============================================
    // Memory Management
    // ============================================

    /**
     * Get current memory stats
     */
    getMemoryStats: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MEMORY_GET_STATS);
    },

    /**
     * Load historical output from disk for an instance
     */
    loadHistoricalOutput: (
      instanceId: string,
      limit?: number
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MEMORY_LOAD_HISTORY, {
        instanceId,
        limit
      });
    },

    /**
     * Listen for memory stats updates
     */
    onMemoryStatsUpdate: (callback: (stats: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, stats: unknown) =>
        callback(stats);
      ipcRenderer.on(ch.MEMORY_STATS_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(ch.MEMORY_STATS_UPDATE, handler);
    },

    /**
     * Listen for memory warnings
     */
    onMemoryWarning: (callback: (warning: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, warning: unknown) =>
        callback(warning);
      ipcRenderer.on(ch.MEMORY_WARNING, handler);
      return () =>
        ipcRenderer.removeListener(ch.MEMORY_WARNING, handler);
    },

    /**
     * Listen for critical memory alerts
     */
    onMemoryCritical: (callback: (alert: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, alert: unknown) =>
        callback(alert);
      ipcRenderer.on(ch.MEMORY_CRITICAL, handler);
      return () =>
        ipcRenderer.removeListener(ch.MEMORY_CRITICAL, handler);
    },

    // ============================================
    // Phase 8: RLM Context (8.1)
    // ============================================

    /**
     * Create or fetch a context store
     */
    rlmCreateStore: (instanceId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_CREATE_STORE, instanceId);
    },

    /**
     * Add a section to a context store
     */
    rlmAddSection: (payload: {
      storeId: string;
      type: 'file' | 'conversation' | 'tool_output' | 'external' | 'summary';
      name: string;
      content: string;
      metadata?: Record<string, unknown>;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_ADD_SECTION, payload);
    },

    /**
     * Remove a section from a context store
     */
    rlmRemoveSection: (payload: {
      storeId: string;
      sectionId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_REMOVE_SECTION, payload);
    },

    /**
     * Get a context store
     */
    rlmGetStore: (storeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_GET_STORE, storeId);
    },

    /**
     * List context stores
     */
    rlmListStores: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_LIST_STORES);
    },

    /**
     * List sections in a store
     */
    rlmListSections: (storeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_LIST_SECTIONS, storeId);
    },

    /**
     * List active RLM sessions
     */
    rlmListSessions: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_LIST_SESSIONS);
    },

    /**
     * Delete a context store
     */
    rlmDeleteStore: (storeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_DELETE_STORE, storeId);
    },

    /**
     * Start an RLM session
     */
    rlmStartSession: (payload: {
      storeId: string;
      instanceId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_START_SESSION, payload);
    },

    /**
     * End an RLM session
     */
    rlmEndSession: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_END_SESSION, sessionId);
    },

    /**
     * Execute an RLM query
     */
    rlmExecuteQuery: (payload: {
      sessionId: string;
      query: { type: string; params: Record<string, unknown> };
      depth?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_EXECUTE_QUERY, payload);
    },

    /**
     * Get an RLM session
     */
    rlmGetSession: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_GET_SESSION, sessionId);
    },

    /**
     * Get RLM store stats
     */
    rlmGetStoreStats: (storeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_GET_STORE_STATS, storeId);
    },

    /**
     * Get RLM session stats
     */
    rlmGetSessionStats: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_GET_SESSION_STATS, sessionId);
    },

    /**
     * Configure RLM
     */
    rlmConfigure: (config: Record<string, unknown>): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_CONFIGURE, config);
    },

    /**
     * Record task outcome for RLM
     */
    rlmRecordOutcome: (payload: {
      instanceId: string;
      taskType: string;
      taskDescription: string;
      prompt: string;
      context?: string;
      agentUsed: string;
      modelUsed: string;
      workflowUsed?: string;
      toolsUsed: {
        tool: string;
        count: number;
        avgDuration: number;
        errorCount: number;
      }[];
      tokensUsed: number;
      duration: number;
      success: boolean;
      completionScore?: number;
      userSatisfaction?: number;
      errorType?: string;
      errorMessage?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_RECORD_OUTCOME, payload);
    },

    /**
     * Get RLM learned patterns
     */
    rlmGetPatterns: (minSuccessRate?: number): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_GET_PATTERNS, {
        minSuccessRate
      });
    },

    /**
     * Get RLM strategy suggestions
     */
    rlmGetStrategySuggestions: (
      context: string,
      maxSuggestions?: number
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_GET_STRATEGY_SUGGESTIONS, {
        context,
        maxSuggestions
      });
    },

    /**
     * Get RLM token savings history
     */
    rlmGetTokenSavingsHistory: (payload?: { range?: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_GET_TOKEN_SAVINGS_HISTORY, payload);
    },

    /**
     * Get RLM query stats
     */
    rlmGetQueryStats: (payload?: { range?: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_GET_QUERY_STATS, payload);
    },

    /**
     * Get RLM storage stats
     */
    rlmGetStorageStats: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RLM_GET_STORAGE_STATS);
    },

    /**
     * Listen for RLM store-updated events
     */
    onRlmStoreUpdated: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.RLM_STORE_UPDATED, handler);
      return () => ipcRenderer.removeListener(ch.RLM_STORE_UPDATED, handler);
    },

    /**
     * Listen for RLM query-complete events
     */
    onRlmQueryComplete: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.RLM_QUERY_COMPLETE, handler);
      return () => ipcRenderer.removeListener(ch.RLM_QUERY_COMPLETE, handler);
    },

    /**
     * Listen for RLM section-added events
     */
    onRlmSectionAdded: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.RLM_SECTION_ADDED, handler);
      return () => ipcRenderer.removeListener(ch.RLM_SECTION_ADDED, handler);
    },

    /**
     * Listen for RLM section-removed events
     */
    onRlmSectionRemoved: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.RLM_SECTION_REMOVED, handler);
      return () => ipcRenderer.removeListener(ch.RLM_SECTION_REMOVED, handler);
    },

    // ============================================
    // Phase 9: Memory-R1 (9.1)
    // ============================================

    /**
     * Memory-R1: Decide what operation to perform
     */
    memoryR1DecideOperation: (payload: {
      context: string;
      candidateContent: string;
      taskId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MEMORY_R1_DECIDE_OPERATION, payload);
    },

    /**
     * Memory-R1: Execute a decided operation
     */
    memoryR1ExecuteOperation: (
      decision: Record<string, unknown>
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.MEMORY_R1_EXECUTE_OPERATION,
        decision
      );
    },

    /**
     * Memory-R1: Add entry directly
     */
    memoryR1AddEntry: (payload: {
      content: string;
      reason: string;
      sourceType?: string;
      sourceSessionId?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MEMORY_R1_ADD_ENTRY, payload);
    },

    /**
     * Memory-R1: Delete entry
     */
    memoryR1DeleteEntry: (entryId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MEMORY_R1_DELETE_ENTRY, entryId);
    },

    /**
     * Memory-R1: Get entry
     */
    memoryR1GetEntry: (entryId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MEMORY_R1_GET_ENTRY, entryId);
    },

    /**
     * Memory-R1: Retrieve memories
     */
    memoryR1Retrieve: (payload: {
      query: string;
      taskId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MEMORY_R1_RETRIEVE, payload);
    },

    /**
     * Memory-R1: Record task outcome
     */
    memoryR1RecordOutcome: (payload: {
      taskId: string;
      success: boolean;
      score: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MEMORY_R1_RECORD_OUTCOME, payload);
    },

    /**
     * Memory-R1: Get stats
     */
    memoryR1GetStats: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MEMORY_R1_GET_STATS);
    },

    /**
     * Memory-R1: Save state
     */
    memoryR1Save: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MEMORY_R1_SAVE);
    },

    /**
     * Memory-R1: Load state
     */
    memoryR1Load: (snapshot: Record<string, unknown>): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MEMORY_R1_LOAD, snapshot);
    },

    /**
     * Memory-R1: Configure
     */
    memoryR1Configure: (
      config: Record<string, unknown>
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MEMORY_R1_CONFIGURE, config);
    },

    // ============================================
    // Phase 9: Unified Memory (9.2)
    // ============================================

    /**
     * Unified Memory: Process input
     */
    unifiedMemoryProcessInput: (payload: {
      input: string;
      sessionId: string;
      taskId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.UNIFIED_MEMORY_PROCESS_INPUT,
        payload
      );
    },

    /**
     * Unified Memory: Retrieve
     */
    unifiedMemoryRetrieve: (payload: {
      query: string;
      taskId: string;
      options?: {
        types?: string[];
        maxTokens?: number;
        sessionId?: string;
        instanceId?: string;
      };
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.UNIFIED_MEMORY_RETRIEVE, payload);
    },

    /**
     * Unified Memory: Record session end
     */
    unifiedMemoryRecordSessionEnd: (payload: {
      sessionId: string;
      outcome: string;
      summary: string;
      lessons: string[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.UNIFIED_MEMORY_RECORD_SESSION_END,
        payload
      );
    },

    /**
     * Unified Memory: Record workflow
     */
    unifiedMemoryRecordWorkflow: (payload: {
      name: string;
      steps: string[];
      applicableContexts: string[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.UNIFIED_MEMORY_RECORD_WORKFLOW,
        payload
      );
    },

    /**
     * Unified Memory: Record strategy
     */
    unifiedMemoryRecordStrategy: (payload: {
      strategy: string;
      conditions: string[];
      taskId: string;
      success: boolean;
      score: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.UNIFIED_MEMORY_RECORD_STRATEGY,
        payload
      );
    },

    /**
     * Unified Memory: Record outcome
     */
    unifiedMemoryRecordOutcome: (payload: {
      taskId: string;
      success: boolean;
      score: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.UNIFIED_MEMORY_RECORD_OUTCOME,
        payload
      );
    },

    /**
     * Unified Memory: Get stats
     */
    unifiedMemoryGetStats: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.UNIFIED_MEMORY_GET_STATS);
    },

    /**
     * Unified Memory: Get sessions
     */
    unifiedMemoryGetSessions: (limit?: number): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.UNIFIED_MEMORY_GET_SESSIONS, limit);
    },

    /**
     * Unified Memory: Get patterns
     */
    unifiedMemoryGetPatterns: (minSuccessRate?: number): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.UNIFIED_MEMORY_GET_PATTERNS,
        minSuccessRate
      );
    },

    /**
     * Unified Memory: Get workflows
     */
    unifiedMemoryGetWorkflows: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.UNIFIED_MEMORY_GET_WORKFLOWS);
    },

    /**
     * Unified Memory: Save state
     */
    unifiedMemorySave: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.UNIFIED_MEMORY_SAVE);
    },

    /**
     * Unified Memory: Load state
     */
    unifiedMemoryLoad: (
      snapshot: Record<string, unknown>
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.UNIFIED_MEMORY_LOAD, snapshot);
    },

    /**
     * Unified Memory: Configure
     */
    unifiedMemoryConfigure: (
      config: Record<string, unknown>
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.UNIFIED_MEMORY_CONFIGURE, config);
    },

    // ============================================
    // Observation Memory
    // ============================================

    observationGetStats: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OBSERVATION_GET_STATS),

    observationGetReflections: (options?: { limit?: number; minConfidence?: number }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OBSERVATION_GET_REFLECTIONS, options),

    observationGetObservations: (payload?: { limit?: number }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OBSERVATION_GET_OBSERVATIONS, payload),

    observationConfigure: (config: Record<string, unknown>): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OBSERVATION_CONFIGURE, config),

    observationGetConfig: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OBSERVATION_GET_CONFIG),

    observationForceReflect: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OBSERVATION_FORCE_REFLECT),

    observationCleanup: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.OBSERVATION_CLEANUP),

    // ============================================
    // Knowledge Graph
    // ============================================

    kgAddFact: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.KG_ADD_FACT, payload),

    kgInvalidateFact: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.KG_INVALIDATE_FACT, payload),

    kgQueryEntity: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.KG_QUERY_ENTITY, payload),

    kgQueryRelationship: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.KG_QUERY_RELATIONSHIP, payload),

    kgGetTimeline: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.KG_GET_TIMELINE, payload),

    kgGetStats: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.KG_GET_STATS),

    kgAddEntity: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.KG_ADD_ENTITY, payload),

    // ============================================
    // Conversation Mining
    // ============================================

    convoImportFile: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CONVO_IMPORT_FILE, payload),

    convoImportString: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CONVO_IMPORT_STRING, payload),

    convoDetectFormat: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CONVO_DETECT_FORMAT, payload),

    // ============================================
    // Wake Context
    // ============================================

    wakeGenerate: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.WAKE_GENERATE, payload),

    wakeGetText: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.WAKE_GET_TEXT, payload),

    wakeAddHint: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.WAKE_ADD_HINT, payload),

    wakeRemoveHint: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.WAKE_REMOVE_HINT, payload),

    wakeSetIdentity: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.WAKE_SET_IDENTITY, payload),

    // Codebase Mining
    codebaseMineDirectory: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CODEBASE_MINE_DIRECTORY, payload),
    codebaseGetStatus: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CODEBASE_GET_STATUS, payload),

    // ============================================
    // Knowledge Event Listeners (main → renderer)
    // ============================================

    onKgFactAdded: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.KG_EVENT_FACT_ADDED, handler);
      return () => ipcRenderer.removeListener(ch.KG_EVENT_FACT_ADDED, handler);
    },

    onKgFactInvalidated: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.KG_EVENT_FACT_INVALIDATED, handler);
      return () =>
        ipcRenderer.removeListener(ch.KG_EVENT_FACT_INVALIDATED, handler);
    },

    onConvoImportComplete: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.CONVO_EVENT_IMPORT_COMPLETE, handler);
      return () =>
        ipcRenderer.removeListener(ch.CONVO_EVENT_IMPORT_COMPLETE, handler);
    },

    onWakeHintAdded: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.WAKE_EVENT_HINT_ADDED, handler);
      return () => ipcRenderer.removeListener(ch.WAKE_EVENT_HINT_ADDED, handler);
    },

    onWakeContextGenerated: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.WAKE_EVENT_CONTEXT_GENERATED, handler);
      return () =>
        ipcRenderer.removeListener(ch.WAKE_EVENT_CONTEXT_GENERATED, handler);
    },
  };
}
