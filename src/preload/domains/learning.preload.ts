import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createLearningDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    // ============================================
    // Phase 8: Learning (8.2)
    // ============================================

    /**
     * Record learning outcome
     */
    learningRecordOutcome: (payload: {
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
      return ipcRenderer.invoke(ch.LEARNING_RECORD_OUTCOME, payload);
    },

    /**
     * Get learning patterns
     */
    learningGetPatterns: (minSuccessRate?: number): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LEARNING_GET_PATTERNS, {
        minSuccessRate
      });
    },

    /**
     * Get learning suggestions
     */
    learningGetSuggestions: (
      context: string,
      maxSuggestions?: number
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LEARNING_GET_SUGGESTIONS, {
        context,
        maxSuggestions
      });
    },

    /**
     * Enhance prompt with learning
     */
    learningEnhancePrompt: (
      prompt: string,
      context: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LEARNING_ENHANCE_PROMPT, {
        prompt,
        context
      });
    },

    /**
     * Get learning insights
     */
    learningGetInsights: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LEARNING_GET_INSIGHTS);
    },

    // ============================================
    // Phase 9: Training/GRPO (9.4)
    // ============================================

    /**
     * Record training outcome
     */
    trainingRecordOutcome: (payload: {
      taskId: string;
      prompt: string;
      response: string;
      reward: number;
      strategy?: string;
      context?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_RECORD_OUTCOME, payload);
    },

    /**
     * Get training stats
     */
    trainingGetStats: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_GET_STATS);
    },

    /**
     * Export training data
     */
    trainingExportData: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_EXPORT_DATA);
    },

    /**
     * Import training data
     */
    trainingImportData: (data: Record<string, unknown>): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_IMPORT_DATA, data);
    },

    /**
     * Get reward trend
     */
    trainingGetTrend: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_GET_TREND);
    },

    /**
     * Get top strategies
     */
    trainingGetTopStrategies: (limit?: number): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_GET_TOP_STRATEGIES, limit);
    },

    /**
     * Configure training
     */
    trainingConfigure: (
      config: Record<string, unknown>
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_CONFIGURE, config);
    },

    /**
     * Get training reward data
     */
    trainingGetRewardData: (payload?: { limit?: number }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_GET_REWARD_DATA, payload);
    },

    /**
     * Get training advantage data
     */
    trainingGetAdvantageData: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_GET_ADVANTAGE_DATA);
    },

    /**
     * Get training strategies
     */
    trainingGetStrategies: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_GET_STRATEGIES);
    },

    /**
     * Get agent performance data
     */
    trainingGetAgentPerformance: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_GET_AGENT_PERFORMANCE);
    },

    /**
     * Get training patterns
     */
    trainingGetPatterns: (payload?: { limit?: number }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_GET_PATTERNS, payload);
    },

    /**
     * Get training insights
     */
    trainingGetInsights: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_GET_INSIGHTS);
    },

    /**
     * Apply a training insight
     */
    trainingApplyInsight: (payload: { insightId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_APPLY_INSIGHT, payload);
    },

    /**
     * Dismiss a training insight
     */
    trainingDismissInsight: (payload: { insightId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_DISMISS_INSIGHT, payload);
    },

    /**
     * Update training configuration
     */
    trainingUpdateConfig: (payload: { config: Record<string, unknown> }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TRAINING_UPDATE_CONFIG, payload);
    },

    // ============================================
    // Phase 7: Specialists (7.4)
    // ============================================

    /**
     * List all specialist profiles
     */
    specialistList: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_LIST);
    },

    /**
     * List built-in specialist profiles
     */
    specialistListBuiltin: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_LIST_BUILTIN);
    },

    /**
     * List custom specialist profiles
     */
    specialistListCustom: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_LIST_CUSTOM);
    },

    /**
     * Get a specialist profile
     */
    specialistGet: (profileId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_GET, { profileId });
    },

    /**
     * Get specialist profiles by category
     */
    specialistGetByCategory: (category: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_GET_BY_CATEGORY, {
        category
      });
    },

    /**
     * Add a custom specialist profile
     */
    specialistAddCustom: (profile: {
      id: string;
      name: string;
      description: string;
      category: string;
      icon: string;
      color: string;
      systemPromptAddition: string;
      restrictedTools: string[];
      constraints?: {
        readOnlyMode?: boolean;
        maxTokens?: number;
        allowedDirectories?: string[];
        blockedDirectories?: string[];
        requireApprovalFor?: string[];
      };
      tags?: string[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_ADD_CUSTOM, { profile });
    },

    /**
     * Update a custom specialist profile
     */
    specialistUpdateCustom: (
      profileId: string,
      updates: {
        name?: string;
        description?: string;
        category?: string;
        icon?: string;
        color?: string;
        systemPromptAddition?: string;
        restrictedTools?: string[];
        constraints?: {
          readOnlyMode?: boolean;
          maxTokens?: number;
          allowedDirectories?: string[];
          blockedDirectories?: string[];
          requireApprovalFor?: string[];
        };
        tags?: string[];
      }
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_UPDATE_CUSTOM, {
        profileId,
        updates
      });
    },

    /**
     * Remove a custom specialist profile
     */
    specialistRemoveCustom: (profileId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_REMOVE_CUSTOM, {
        profileId
      });
    },

    /**
     * Get specialist recommendations based on context
     */
    specialistRecommend: (context: {
      taskDescription?: string;
      fileTypes?: string[];
      userPreferences?: string[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_RECOMMEND, { context });
    },

    /**
     * Create a specialist instance
     */
    specialistCreateInstance: (
      profileId: string,
      orchestratorInstanceId: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_CREATE_INSTANCE, {
        profileId,
        orchestratorInstanceId
      });
    },

    /**
     * Get a specialist instance
     */
    specialistGetInstance: (instanceId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_GET_INSTANCE, {
        instanceId
      });
    },

    /**
     * Get all active specialist instances
     */
    specialistGetActiveInstances: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_GET_ACTIVE_INSTANCES);
    },

    /**
     * Update specialist instance status
     */
    specialistUpdateStatus: (
      instanceId: string,
      status: 'active' | 'paused' | 'completed' | 'failed'
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_UPDATE_STATUS, {
        instanceId,
        status
      });
    },

    /**
     * Add a finding to a specialist instance
     */
    specialistAddFinding: (
      instanceId: string,
      finding: {
        id: string;
        type: string;
        severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
        title: string;
        description: string;
        filePath?: string;
        lineRange?: { start: number; end: number };
        codeSnippet?: string;
        suggestion?: string;
        confidence: number;
        tags?: string[];
      }
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_ADD_FINDING, {
        instanceId,
        finding
      });
    },

    /**
     * Update specialist instance metrics
     */
    specialistUpdateMetrics: (
      instanceId: string,
      updates: {
        filesAnalyzed?: number;
        linesAnalyzed?: number;
        findingsCount?: number;
        tokensUsed?: number;
        durationMs?: number;
      }
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_UPDATE_METRICS, {
        instanceId,
        updates
      });
    },

    /**
     * Get system prompt addition for a specialist
     */
    specialistGetPromptAddition: (profileId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SPECIALIST_GET_PROMPT_ADDITION, {
        profileId
      });
    },

    // ============================================
    // A/B Testing
    // ============================================

    abCreateExperiment: (payload: Record<string, unknown>): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_CREATE_EXPERIMENT, payload),

    abGetExperiment: (experimentId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_GET_EXPERIMENT, { experimentId }),

    abListExperiments: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_LIST_EXPERIMENTS),

    abStartExperiment: (experimentId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_START_EXPERIMENT, { experimentId }),

    abPauseExperiment: (experimentId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_PAUSE_EXPERIMENT, { experimentId }),

    abCompleteExperiment: (experimentId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_COMPLETE_EXPERIMENT, { experimentId }),

    abGetVariant: (payload: { experimentId: string; sessionId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_GET_VARIANT, payload),

    abRecordOutcome: (payload: Record<string, unknown>): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_RECORD_OUTCOME, payload),

    abGetResults: (experimentId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_GET_RESULTS, { experimentId }),

    abGetWinner: (experimentId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_GET_WINNER, { experimentId }),

    abGetStats: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_GET_STATS),

    abConfigure: (config: Record<string, unknown>): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_CONFIGURE, config),

    abUpdateExperiment: (payload: { experimentId: string; updates: Record<string, unknown> }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_UPDATE_EXPERIMENT, payload),

    abDeleteExperiment: (experimentId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AB_DELETE_EXPERIMENT, experimentId),
  };
}
