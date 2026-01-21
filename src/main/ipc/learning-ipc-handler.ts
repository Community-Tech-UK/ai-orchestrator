/**
 * Learning IPC Handlers
 * Handles RLM Context Management, Self-Improvement/Learning, Model Discovery, and A/B Testing
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { RLMContextManager } from '../rlm/context-manager';
import { OutcomeTracker } from '../learning/outcome-tracker';
import { StrategyLearner } from '../learning/strategy-learner';
import { PromptEnhancer } from '../learning/prompt-enhancer';
import { ABTestingEngine, type Experiment, type Variant, type ABTestingConfig } from '../learning/ab-testing';
import type {
  ContextQuery,
  RLMConfig,
  ContextStore,
  ContextSection,
  RLMSession,
  RLMStoreStats,
  RLMSessionStats,
  ContextQueryResult,
} from '../../shared/types/rlm.types';
import type {
  TaskOutcome,
  TaskPattern,
  ToolUsageRecord,
  Experience,
  LearningInsight,
  StrategyRecommendation,
  PromptEnhancement,
  LearningStats,
  TaskTypeStats,
  SelfImprovementConfig,
} from '../../shared/types/self-improvement.types';

/**
 * Register all learning-related IPC handlers
 */
export function registerLearningHandlers(): void {
  registerRLMHandlers();
  registerSelfImprovementHandlers();
  registerModelDiscoveryHandlers();
  registerABTestingHandlers();
}

// ============ RLM Context Management Handlers ============

function registerRLMHandlers(): void {
  const rlm = RLMContextManager.getInstance();
  const tracker = OutcomeTracker.getInstance();
  const strategist = StrategyLearner.getInstance();

  // Create store
  ipcMain.handle(IPC_CHANNELS.RLM_CREATE_STORE, (_event, instanceId: string): ContextStore => {
    return rlm.createStore(instanceId);
  });

  // Add section
  ipcMain.handle(
    IPC_CHANNELS.RLM_ADD_SECTION,
    (
      _event,
      payload: {
        storeId: string;
        type: ContextSection['type'];
        name: string;
        content: string;
        metadata?: Partial<ContextSection>;
      }
    ): ContextSection => {
      return rlm.addSection(payload.storeId, payload.type, payload.name, payload.content, payload.metadata);
    }
  );

  // Remove section
  ipcMain.handle(
    IPC_CHANNELS.RLM_REMOVE_SECTION,
    (_event, payload: { storeId: string; sectionId: string }): boolean => {
      return rlm.removeSection(payload.storeId, payload.sectionId);
    }
  );

  // Get store
  ipcMain.handle(IPC_CHANNELS.RLM_GET_STORE, (_event, storeId: string): ContextStore | undefined => {
    return rlm.getStore(storeId);
  });

  // List stores
  ipcMain.handle(IPC_CHANNELS.RLM_LIST_STORES, (): ContextStore[] => {
    return rlm.listStores();
  });

  // List sections
  ipcMain.handle(IPC_CHANNELS.RLM_LIST_SECTIONS, (_event, storeId: string): ContextSection[] => {
    return rlm.listSections(storeId);
  });

  // List active sessions
  ipcMain.handle(IPC_CHANNELS.RLM_LIST_SESSIONS, (): RLMSession[] => {
    return rlm.listSessions();
  });

  // Delete store
  ipcMain.handle(IPC_CHANNELS.RLM_DELETE_STORE, (_event, storeId: string): void => {
    rlm.deleteStore(storeId);
  });

  // Start session
  ipcMain.handle(
    IPC_CHANNELS.RLM_START_SESSION,
    async (_event, payload: { storeId: string; instanceId: string }): Promise<RLMSession> => {
      return rlm.startSession(payload.storeId, payload.instanceId);
    }
  );

  // End session
  ipcMain.handle(IPC_CHANNELS.RLM_END_SESSION, (_event, sessionId: string): void => {
    rlm.endSession(sessionId);
  });

  // Execute query
  ipcMain.handle(
    IPC_CHANNELS.RLM_EXECUTE_QUERY,
    async (
      _event,
      payload: { sessionId: string; query: ContextQuery; depth?: number }
    ): Promise<ContextQueryResult> => {
      return rlm.executeQuery(payload.sessionId, payload.query, payload.depth);
    }
  );

  // Get session
  ipcMain.handle(IPC_CHANNELS.RLM_GET_SESSION, (_event, sessionId: string): RLMSession | undefined => {
    return rlm.getSession(sessionId);
  });

  // Get store stats
  ipcMain.handle(IPC_CHANNELS.RLM_GET_STORE_STATS, (_event, storeId: string): RLMStoreStats | undefined => {
    return rlm.getStoreStats(storeId);
  });

  // Get session stats
  ipcMain.handle(
    IPC_CHANNELS.RLM_GET_SESSION_STATS,
    (_event, sessionId: string): RLMSessionStats | undefined => {
      return rlm.getSessionStats(sessionId);
    }
  );

  // Configure RLM
  ipcMain.handle(IPC_CHANNELS.RLM_CONFIGURE, (_event, config: Partial<RLMConfig>): void => {
    rlm.configure(config);
  });

  // Record outcome (RLM alias for learning outcomes)
  ipcMain.handle(
    IPC_CHANNELS.RLM_RECORD_OUTCOME,
    (
      _event,
      payload: {
        instanceId: string;
        taskType: string;
        taskDescription: string;
        prompt: string;
        context?: string;
        agentUsed: string;
        modelUsed: string;
        workflowUsed?: string;
        toolsUsed: ToolUsageRecord[];
        tokensUsed: number;
        duration: number;
        success: boolean;
        completionScore?: number;
        userSatisfaction?: number;
        errorType?: string;
        errorMessage?: string;
      }
    ): TaskOutcome => {
      return tracker.recordOutcome(payload);
    }
  );

  // Get patterns (RLM alias)
  ipcMain.handle(
    IPC_CHANNELS.RLM_GET_PATTERNS,
    (_event, payload: { minSuccessRate?: number }): TaskPattern[] => {
      const minSuccessRate = payload?.minSuccessRate ?? 0;
      return tracker.getTopPatterns(50).filter(p => p.effectiveness >= minSuccessRate);
    }
  );

  // Get strategy suggestions (RLM alias)
  ipcMain.handle(
    IPC_CHANNELS.RLM_GET_STRATEGY_SUGGESTIONS,
    (_event, payload: { context: string; maxSuggestions?: number }): StrategyRecommendation => {
      return strategist.getRecommendation('general', payload.context, payload.context);
    }
  );

  // ============ RLM Analytics Handlers ============

  // Get token savings history
  ipcMain.handle('rlm:get-token-savings-history', (_event, payload: { range: string }) => {
    try {
      const days = payload.range === '7d' ? 7 : payload.range === '90d' ? 90 : 30;
      const history = rlm.getTokenSavingsHistory(days);
      return { success: true, data: history };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get query statistics
  ipcMain.handle('rlm:get-query-stats', (_event, payload: { range: string }) => {
    try {
      const days = payload.range === '7d' ? 7 : payload.range === '90d' ? 90 : 30;
      const stats = rlm.getQueryStats(days);
      return { success: true, data: stats };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get storage statistics
  ipcMain.handle('rlm:get-storage-stats', () => {
    try {
      const stats = rlm.getStorageStats();
      return { success: true, data: stats };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ============ RLM Export/Import Handlers ============

  // Export store to JSON
  ipcMain.handle('rlm:export-store', (_event, storeId: string) => {
    try {
      const data = rlm.exportStore(storeId);
      if (!data) {
        return { success: false, error: 'Store not found' };
      }
      return { success: true, data };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Import store from JSON
  ipcMain.handle('rlm:import-store', (_event, payload: {
    data: ReturnType<typeof rlm.exportStore>;
    options?: {
      newId?: boolean;
      merge?: boolean;
      targetStoreId?: string;
      instanceId?: string;
    };
  }) => {
    try {
      if (!payload.data) {
        return { success: false, error: 'Invalid import data' };
      }
      const storeId = rlm.importStore(payload.data, payload.options);
      return { success: true, data: { storeId } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}

// ============ Self-Improvement Handlers ============

function registerSelfImprovementHandlers(): void {
  const tracker = OutcomeTracker.getInstance();
  const strategist = StrategyLearner.getInstance();
  const enhancer = PromptEnhancer.getInstance();

  // Record outcome
  ipcMain.handle(
    IPC_CHANNELS.LEARNING_RECORD_OUTCOME,
    (
      _event,
      payload: {
        instanceId: string;
        taskType: string;
        taskDescription: string;
        prompt: string;
        context?: string;
        agentUsed: string;
        modelUsed: string;
        workflowUsed?: string;
        toolsUsed: ToolUsageRecord[];
        tokensUsed: number;
        duration: number;
        success: boolean;
        completionScore?: number;
        userSatisfaction?: number;
        errorType?: string;
        errorMessage?: string;
      }
    ): TaskOutcome => {
      return tracker.recordOutcome(payload);
    }
  );

  // Get outcome
  ipcMain.handle(IPC_CHANNELS.LEARNING_GET_OUTCOME, (_event, outcomeId: string): TaskOutcome | undefined => {
    return tracker.getOutcome(outcomeId);
  });

  // Get recent outcomes
  ipcMain.handle(IPC_CHANNELS.LEARNING_GET_RECENT_OUTCOMES, (_event, limit?: number): TaskOutcome[] => {
    return tracker.getRecentOutcomes(limit);
  });

  // Get experience
  ipcMain.handle(IPC_CHANNELS.LEARNING_GET_EXPERIENCE, (_event, taskType: string): Experience | undefined => {
    return tracker.getExperience(taskType);
  });

  // Get all experiences
  ipcMain.handle(IPC_CHANNELS.LEARNING_GET_ALL_EXPERIENCES, (): Experience[] => {
    return tracker.getAllExperiences();
  });

  // Get insights
  ipcMain.handle(
    IPC_CHANNELS.LEARNING_GET_INSIGHTS,
    (_event, payload?: { taskType?: string; minConfidence?: number }): LearningInsight[] => {
      return tracker.getInsights(payload?.taskType, payload?.minConfidence);
    }
  );

  // Get recommendation
  ipcMain.handle(
    IPC_CHANNELS.LEARNING_GET_RECOMMENDATION,
    (
      _event,
      payload: { taskType: string; taskDescription?: string; context?: string }
    ): StrategyRecommendation => {
      return strategist.getRecommendation(payload.taskType, payload.taskDescription, payload.context);
    }
  );

  // Enhance prompt
  ipcMain.handle(
    IPC_CHANNELS.LEARNING_ENHANCE_PROMPT,
    (_event, payload: { prompt: string; taskType?: string; context?: string }): PromptEnhancement => {
      return enhancer.enhance(payload.prompt, payload.taskType, payload.context);
    }
  );

  // Get stats
  ipcMain.handle(IPC_CHANNELS.LEARNING_GET_STATS, (): LearningStats => {
    return tracker.getStats();
  });

  // Get task type stats
  ipcMain.handle(
    IPC_CHANNELS.LEARNING_GET_TASK_STATS,
    (_event, taskType: string): TaskTypeStats | undefined => {
      return tracker.getTaskTypeStats(taskType);
    }
  );

  // Rate outcome
  ipcMain.handle(
    IPC_CHANNELS.LEARNING_RATE_OUTCOME,
    (_event, payload: { outcomeId: string; satisfaction: number }): boolean => {
      return tracker.rateOutcome(payload.outcomeId, payload.satisfaction);
    }
  );

  // Configure learning
  ipcMain.handle(IPC_CHANNELS.LEARNING_CONFIGURE, (_event, config: Partial<SelfImprovementConfig>): void => {
    tracker.configure(config);
  });
}

// ============ Model Discovery Handlers ============

function registerModelDiscoveryHandlers(): void {
  // Note: The model discovery service exists at src/main/providers/model-discovery.ts
  // These handlers integrate with the existing ModelDiscoveryService

  // Import the existing service
  const { getModelDiscoveryService } = require('../providers/model-discovery');
  const discoveryService = getModelDiscoveryService();

  // Discover models
  ipcMain.handle(
    IPC_CHANNELS.MODEL_DISCOVER,
    async (_event, config: { type: string; apiKey?: string; baseUrl?: string }) => {
      return discoveryService.discoverModels(config);
    }
  );

  // Get all models for a provider
  ipcMain.handle(IPC_CHANNELS.MODEL_GET_ALL, async (_event, config: { type: string; apiKey?: string }) => {
    return discoveryService.discoverModels(config);
  });

  // Get specific model
  ipcMain.handle(
    IPC_CHANNELS.MODEL_GET,
    async (_event, payload: { config: { type: string; apiKey?: string }; modelId: string }) => {
      return discoveryService.getModelDetails(payload.config, payload.modelId);
    }
  );

  // Select best model (simple implementation - returns first available)
  ipcMain.handle(
    IPC_CHANNELS.MODEL_SELECT,
    async (
      _event,
      payload: { config: { type: string; apiKey?: string }; criteria: { capabilities?: string[] } }
    ) => {
      const models = await discoveryService.discoverModels(payload.config);
      return models.length > 0 ? models[0] : null;
    }
  );

  // Configure provider - not directly supported by existing service, return success
  ipcMain.handle(IPC_CHANNELS.MODEL_CONFIGURE_PROVIDER, async () => {
    return { success: true };
  });

  // Get provider status
  ipcMain.handle(IPC_CHANNELS.MODEL_GET_PROVIDER_STATUS, async (_event, config: { type: string }) => {
    return {
      provider: config.type,
      enabled: true,
      configured: true,
      connected: true,
    };
  });

  // Get stats
  ipcMain.handle(IPC_CHANNELS.MODEL_GET_STATS, async () => {
    return {
      totalProviders: 6,
      enabledProviders: 1,
      connectedProviders: 1,
      totalModels: 0,
      availableModels: 0,
    };
  });

  // Verify model
  ipcMain.handle(
    IPC_CHANNELS.MODEL_VERIFY,
    async (_event, payload: { config: { type: string; apiKey?: string }; modelId: string }) => {
      return discoveryService.isModelAvailable(payload.config, payload.modelId);
    }
  );

  // Set override - store locally (placeholder)
  ipcMain.handle(IPC_CHANNELS.MODEL_SET_OVERRIDE, async () => {
    return { success: true };
  });

  // Remove override - placeholder
  ipcMain.handle(IPC_CHANNELS.MODEL_REMOVE_OVERRIDE, async () => {
    return { success: true };
  });
}

// ============ A/B Testing Handlers ============

function registerABTestingHandlers(): void {
  const abEngine = ABTestingEngine.getInstance();

  // Create experiment
  ipcMain.handle(
    IPC_CHANNELS.AB_CREATE_EXPERIMENT,
    (
      _event,
      payload: {
        name: string;
        description?: string;
        taskType: string;
        variants: Omit<Variant, 'id'>[];
        minSamples?: number;
        confidenceThreshold?: number;
      }
    ) => {
      try {
        const experiment = abEngine.createExperiment(payload);
        return { success: true, data: experiment };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Update experiment
  ipcMain.handle(
    IPC_CHANNELS.AB_UPDATE_EXPERIMENT,
    (
      _event,
      payload: {
        experimentId: string;
        updates: Partial<Pick<Experiment, 'name' | 'description' | 'minSamples' | 'confidenceThreshold'>>;
      }
    ) => {
      try {
        const experiment = abEngine.updateExperiment(payload.experimentId, payload.updates);
        if (!experiment) {
          return { success: false, error: 'Experiment not found or cannot be updated' };
        }
        return { success: true, data: experiment };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Delete experiment
  ipcMain.handle(IPC_CHANNELS.AB_DELETE_EXPERIMENT, (_event, experimentId: string) => {
    try {
      const deleted = abEngine.deleteExperiment(experimentId);
      return { success: deleted, error: deleted ? undefined : 'Experiment not found' };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Start experiment
  ipcMain.handle(IPC_CHANNELS.AB_START_EXPERIMENT, (_event, experimentId: string) => {
    try {
      const started = abEngine.startExperiment(experimentId);
      return { success: started, error: started ? undefined : 'Failed to start experiment' };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Pause experiment
  ipcMain.handle(IPC_CHANNELS.AB_PAUSE_EXPERIMENT, (_event, experimentId: string) => {
    try {
      const paused = abEngine.pauseExperiment(experimentId);
      return { success: paused, error: paused ? undefined : 'Failed to pause experiment' };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Complete experiment
  ipcMain.handle(IPC_CHANNELS.AB_COMPLETE_EXPERIMENT, (_event, experimentId: string) => {
    try {
      const result = abEngine.completeExperiment(experimentId);
      if (!result) {
        return { success: false, error: 'Experiment not found' };
      }
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get experiment
  ipcMain.handle(IPC_CHANNELS.AB_GET_EXPERIMENT, (_event, experimentId: string) => {
    try {
      const experiment = abEngine.getExperiment(experimentId);
      if (!experiment) {
        return { success: false, error: 'Experiment not found' };
      }
      return { success: true, data: experiment };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // List experiments
  ipcMain.handle(
    IPC_CHANNELS.AB_LIST_EXPERIMENTS,
    (_event, filter?: { status?: Experiment['status']; taskType?: string }) => {
      try {
        const experiments = abEngine.listExperiments(filter);
        return { success: true, data: experiments };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Get variant for task
  ipcMain.handle(
    IPC_CHANNELS.AB_GET_VARIANT,
    (_event, payload: { taskType: string; sessionId?: string }) => {
      try {
        const result = abEngine.getVariant(payload.taskType, payload.sessionId);
        if (!result) {
          return { success: true, data: null }; // No experiment running for this task type
        }
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Record outcome
  ipcMain.handle(
    IPC_CHANNELS.AB_RECORD_OUTCOME,
    (
      _event,
      payload: {
        experimentId: string;
        variantId: string;
        outcome: { success: boolean; duration?: number; tokens?: number; metadata?: Record<string, unknown> };
      }
    ) => {
      try {
        abEngine.recordOutcome(payload.experimentId, payload.variantId, payload.outcome);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Get results
  ipcMain.handle(IPC_CHANNELS.AB_GET_RESULTS, (_event, experimentId: string) => {
    try {
      const results = abEngine.getResults(experimentId);
      return { success: true, data: results };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get winner
  ipcMain.handle(IPC_CHANNELS.AB_GET_WINNER, (_event, experimentId: string) => {
    try {
      const winner = abEngine.getWinner(experimentId);
      return { success: true, data: winner };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get stats
  ipcMain.handle(IPC_CHANNELS.AB_GET_STATS, () => {
    try {
      const stats = abEngine.getStats();
      return { success: true, data: stats };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Configure
  ipcMain.handle(IPC_CHANNELS.AB_CONFIGURE, (_event, config: Partial<ABTestingConfig>) => {
    try {
      abEngine.configure(config);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
