/**
 * Learning IPC Handlers
 * Handles RLM Context Management, Self-Improvement/Learning, Model Discovery, and A/B Testing
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import {
  RlmAddSectionPayloadSchema,
  RlmConfigurePayloadSchema,
  RlmCreateStorePayloadSchema,
  RlmEmptyPayloadSchema,
  RlmExecuteQueryPayloadSchema,
  RlmRemoveSectionPayloadSchema,
  RlmSessionIdPayloadSchema,
  RlmStartSessionPayloadSchema,
  RlmStoreIdPayloadSchema,
  RlmGetPatternsPayloadSchema,
  RlmGetStrategySuggestionsPayloadSchema,
  RlmTokenSavingsPayloadSchema,
  RlmQueryStatsPayloadSchema,
  LearningConfigurePayloadSchema,
  LearningEmptyPayloadSchema,
  LearningGetInsightsPayloadSchema,
  LearningOutcomeIdPayloadSchema,
  LearningRecentOutcomesPayloadSchema,
  LearningRecordOutcomePayloadSchema,
  LearningGetRecommendationPayloadSchema,
  LearningEnhancePromptPayloadSchema,
  LearningRateOutcomePayloadSchema,
  LearningTaskTypePayloadSchema,
  AbConfigurePayloadSchema,
  AbCreateExperimentPayloadSchema,
  AbDeleteExperimentPayloadSchema,
  AbEmptyPayloadSchema,
  AbExperimentIdPayloadSchema,
  AbUpdateExperimentPayloadSchema,
  AbGetVariantPayloadSchema,
  AbRecordOutcomePayloadSchema,
  AbListExperimentsPayloadSchema,
} from '@contracts/schemas/session';
import { RLMContextManager } from '../rlm/context-manager';
import { OutcomeTracker } from '../learning/outcome-tracker';
import { StrategyLearner } from '../learning/strategy-learner';
import { PromptEnhancer } from '../learning/prompt-enhancer';
import { ABTestingEngine } from '../learning/ab-testing';
import type { ContextSection } from '../../shared/types/rlm.types';
import {
  serializeContextSectionForIpc,
  serializeContextStoreForIpc,
} from './rlm-ipc-serialization';
import { registerModelDiscoveryHandlers } from './model-discovery-ipc-handlers';
import { validatedHandler, type IpcResponse } from './validated-handler';

interface RegisterLearningHandlersDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

/**
 * Register all learning-related IPC handlers
 */
export function registerLearningHandlers(deps: RegisterLearningHandlersDeps = {}): void {
  registerRLMHandlers(deps);
  registerSelfImprovementHandlers(deps);
  registerModelDiscoveryHandlers(deps);
  registerABTestingHandlers(deps);
}

// ============ RLM Context Management Handlers ============

function registerRLMHandlers(deps: RegisterLearningHandlersDeps): void {
  const rlm = RLMContextManager.getInstance();
  const tracker = OutcomeTracker.getInstance();
  const strategist = StrategyLearner.getInstance();

  // Create store
  registerRlmHandler(IPC_CHANNELS.RLM_CREATE_STORE, RlmCreateStorePayloadSchema, (instanceId) => {
    return serializeContextStoreForIpc(rlm.createStore(instanceId), {
      includeSections: true,
    });
  }, deps);

  // Add section
  registerRlmHandler(
    IPC_CHANNELS.RLM_ADD_SECTION,
    RlmAddSectionPayloadSchema,
    (payload) => {
      return serializeContextSectionForIpc(
        rlm.addSection(payload.storeId, payload.type, payload.name, payload.content, payload.metadata as Partial<ContextSection> | undefined),
      );
    },
    deps,
  );

  // Remove section
  registerRlmHandler(
    IPC_CHANNELS.RLM_REMOVE_SECTION,
    RlmRemoveSectionPayloadSchema,
    (payload) => rlm.removeSection(payload.storeId, payload.sectionId),
    deps,
  );

  // Get store
  registerRlmHandler(IPC_CHANNELS.RLM_GET_STORE, RlmStoreIdPayloadSchema, (storeId) => {
    const store = rlm.getStore(storeId);
    return store
      ? serializeContextStoreForIpc(store, {
        includeSections: true,
        sectionLimit: 1_000,
      })
      : undefined;
  }, deps);

  // List stores
  registerRlmHandler(IPC_CHANNELS.RLM_LIST_STORES, RlmEmptyPayloadSchema, () => {
    return rlm.listStores().map((store) => serializeContextStoreForIpc(store));
  }, deps);

  // List sections
  registerRlmHandler(IPC_CHANNELS.RLM_LIST_SECTIONS, RlmStoreIdPayloadSchema, (storeId) => {
    return rlm.listSections(storeId).map((section) => serializeContextSectionForIpc(section));
  }, deps);

  // List active sessions
  registerRlmHandler(IPC_CHANNELS.RLM_LIST_SESSIONS, RlmEmptyPayloadSchema, () => {
    return rlm.listSessions();
  }, deps);

  // Delete store
  registerRlmHandler(IPC_CHANNELS.RLM_DELETE_STORE, RlmStoreIdPayloadSchema, (storeId) => {
    rlm.deleteStore(storeId);
  }, deps);

  // Start session
  registerRlmHandler(
    IPC_CHANNELS.RLM_START_SESSION,
    RlmStartSessionPayloadSchema,
    (payload) => rlm.startSession(payload.storeId, payload.instanceId),
    deps,
  );

  // End session
  registerRlmHandler(IPC_CHANNELS.RLM_END_SESSION, RlmSessionIdPayloadSchema, (sessionId) => {
    rlm.endSession(sessionId);
  }, deps);

  // Execute query
  registerRlmHandler(
    IPC_CHANNELS.RLM_EXECUTE_QUERY,
    RlmExecuteQueryPayloadSchema,
    (payload) => rlm.executeQuery(payload.sessionId, payload.query, payload.depth),
    deps,
  );

  // Get session
  registerRlmHandler(
    IPC_CHANNELS.RLM_GET_SESSION,
    RlmSessionIdPayloadSchema,
    (sessionId) => rlm.getSession(sessionId),
    deps,
  );

  // Get store stats
  registerRlmHandler(
    IPC_CHANNELS.RLM_GET_STORE_STATS,
    RlmStoreIdPayloadSchema,
    (storeId) => rlm.getStoreStats(storeId),
    deps,
  );

  // Get session stats
  registerRlmHandler(
    IPC_CHANNELS.RLM_GET_SESSION_STATS,
    RlmSessionIdPayloadSchema,
    (sessionId) => rlm.getSessionStats(sessionId),
    deps,
  );

  // Configure RLM
  registerRlmHandler(IPC_CHANNELS.RLM_CONFIGURE, RlmConfigurePayloadSchema, (config) => {
    rlm.configure(config);
  }, deps);

  // Record outcome (RLM alias for learning outcomes)
  registerRlmHandler(
    IPC_CHANNELS.RLM_RECORD_OUTCOME,
    LearningRecordOutcomePayloadSchema,
    (payload) => tracker.recordOutcome(payload),
    deps,
  );

  // Get patterns (RLM alias)
  registerRlmHandler(
    IPC_CHANNELS.RLM_GET_PATTERNS,
    RlmGetPatternsPayloadSchema,
    (payload) => {
      const minSuccessRate = payload?.minSuccessRate ?? 0;
      return tracker.getTopPatterns(50).filter(p => p.effectiveness >= minSuccessRate);
    },
    deps,
  );

  // Renderer-facing learning alias used by the training page.
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_GET_PATTERNS,
    RlmGetPatternsPayloadSchema,
    (payload) => {
      const minSuccessRate = payload?.minSuccessRate ?? 0;
      return tracker.getTopPatterns(50).filter(p => p.effectiveness >= minSuccessRate);
    },
    deps,
  );

  // Get strategy suggestions (RLM alias)
  registerRlmHandler(
    IPC_CHANNELS.RLM_GET_STRATEGY_SUGGESTIONS,
    RlmGetStrategySuggestionsPayloadSchema,
    (payload) => strategist.getRecommendation('general', payload.context, payload.context),
    deps,
  );

  // Renderer-facing learning alias used by the training page.
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_GET_SUGGESTIONS,
    RlmGetStrategySuggestionsPayloadSchema,
    (payload) => strategist.getRecommendation('general', payload.context, payload.context),
    deps,
  );

  // ============ RLM Analytics Handlers ============

  // Get token savings history
  registerRlmHandler(
    IPC_CHANNELS.RLM_GET_TOKEN_SAVINGS_HISTORY,
    RlmTokenSavingsPayloadSchema,
    (payload) => {
      const days = payload.range === '7d' ? 7 : payload.range === '90d' ? 90 : 30;
      return rlm.getTokenSavingsHistory(days);
    },
    deps,
  );

  // Get query statistics
  registerRlmHandler(
    IPC_CHANNELS.RLM_GET_QUERY_STATS,
    RlmQueryStatsPayloadSchema,
    (payload) => {
      const days = payload.range === '7d' ? 7 : payload.range === '90d' ? 90 : 30;
      return rlm.getQueryStats(days);
    },
    deps,
  );

  // Get storage statistics
  registerRlmHandler(
    IPC_CHANNELS.RLM_GET_STORAGE_STATS,
    RlmEmptyPayloadSchema,
    () => rlm.getStorageStats(),
    deps,
  );

}

function registerRlmHandler<TPayload, TResult>(
  channel: string,
  schema: z.ZodSchema<TPayload>,
  call: (payload: TPayload) => TResult | Promise<TResult>,
  deps: RegisterLearningHandlersDeps,
): void {
  const errorCode = `${channel.replace(/[:-]/g, '_').toUpperCase()}_FAILED`;
  ipcMain.handle(
    channel,
    validatedHandler(
      channel,
      schema,
      async (payload): Promise<IpcResponse<TResult>> => {
        const data = await call(payload);
        return data === undefined
          ? { success: true }
          : { success: true, data };
      },
      {
        ensureTrustedSender: deps.ensureTrustedSender,
        errorCode,
      },
    ),
  );
}

// ============ Self-Improvement Handlers ============

function registerSelfImprovementHandlers(deps: RegisterLearningHandlersDeps): void {
  const tracker = OutcomeTracker.getInstance();
  const strategist = StrategyLearner.getInstance();
  const enhancer = PromptEnhancer.getInstance();

  // Record outcome
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_RECORD_OUTCOME,
    LearningRecordOutcomePayloadSchema,
    (payload) => tracker.recordOutcome(payload),
    deps,
  );

  // Get outcome
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_GET_OUTCOME,
    LearningOutcomeIdPayloadSchema,
    (outcomeId) => tracker.getOutcome(outcomeId),
    deps,
  );

  // Get recent outcomes
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_GET_RECENT_OUTCOMES,
    LearningRecentOutcomesPayloadSchema,
    (limit) => tracker.getRecentOutcomes(limit),
    deps,
  );

  // Get experience
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_GET_EXPERIENCE,
    LearningTaskTypePayloadSchema,
    (taskType) => tracker.getExperience(taskType),
    deps,
  );

  // Get all experiences
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_GET_ALL_EXPERIENCES,
    LearningEmptyPayloadSchema,
    () => tracker.getAllExperiences(),
    deps,
  );

  // Get insights
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_GET_INSIGHTS,
    LearningGetInsightsPayloadSchema,
    (payload) => tracker.getInsights(payload?.taskType, payload?.minConfidence),
    deps,
  );

  // Get recommendation
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_GET_RECOMMENDATION,
    LearningGetRecommendationPayloadSchema,
    (payload) => strategist.getRecommendation(payload.taskType, payload.taskDescription, payload.context),
    deps,
  );

  // Enhance prompt
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_ENHANCE_PROMPT,
    LearningEnhancePromptPayloadSchema,
    (payload) => enhancer.enhance(payload.prompt, payload.taskType, payload.context),
    deps,
  );

  // Get stats
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_GET_STATS,
    LearningEmptyPayloadSchema,
    () => tracker.getStats(),
    deps,
  );

  // Get task type stats
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_GET_TASK_STATS,
    LearningTaskTypePayloadSchema,
    (taskType) => tracker.getTaskTypeStats(taskType),
    deps,
  );

  // Rate outcome
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_RATE_OUTCOME,
    LearningRateOutcomePayloadSchema,
    (payload) => tracker.rateOutcome(payload.outcomeId, payload.satisfaction),
    deps,
  );

  // Configure learning
  registerRlmHandler(
    IPC_CHANNELS.LEARNING_CONFIGURE,
    LearningConfigurePayloadSchema,
    (config) => tracker.configure(config),
    deps,
  );
}

// ============ A/B Testing Handlers ============

function registerABTestingHandlers(deps: RegisterLearningHandlersDeps): void {
  const abEngine = ABTestingEngine.getInstance();

  // Create experiment
  registerRlmHandler(
    IPC_CHANNELS.AB_CREATE_EXPERIMENT,
    AbCreateExperimentPayloadSchema,
    (payload) => abEngine.createExperiment(payload),
    deps,
  );

  // Update experiment
  registerRlmHandler(
    IPC_CHANNELS.AB_UPDATE_EXPERIMENT,
    AbUpdateExperimentPayloadSchema,
    (payload) => {
      const experiment = abEngine.updateExperiment(payload.experimentId, payload.updates);
      if (!experiment) {
        throw new Error('Experiment not found or cannot be updated');
      }
      return experiment;
    },
    deps,
  );

  // Delete experiment
  registerRlmHandler(
    IPC_CHANNELS.AB_DELETE_EXPERIMENT,
    AbDeleteExperimentPayloadSchema,
    (experimentId) => {
      if (!abEngine.deleteExperiment(experimentId)) {
        throw new Error('Experiment not found');
      }
      return true;
    },
    deps,
  );

  // Start experiment
  registerRlmHandler(
    IPC_CHANNELS.AB_START_EXPERIMENT,
    AbExperimentIdPayloadSchema,
    (payload) => {
      if (!abEngine.startExperiment(payload.experimentId)) {
        throw new Error('Failed to start experiment');
      }
      return true;
    },
    deps,
  );

  // Pause experiment
  registerRlmHandler(
    IPC_CHANNELS.AB_PAUSE_EXPERIMENT,
    AbExperimentIdPayloadSchema,
    (payload) => {
      if (!abEngine.pauseExperiment(payload.experimentId)) {
        throw new Error('Failed to pause experiment');
      }
      return true;
    },
    deps,
  );

  // Complete experiment
  registerRlmHandler(
    IPC_CHANNELS.AB_COMPLETE_EXPERIMENT,
    AbExperimentIdPayloadSchema,
    (payload) => {
      const result = abEngine.completeExperiment(payload.experimentId);
      if (!result) {
        throw new Error('Experiment not found');
      }
      return result;
    },
    deps,
  );

  // Get experiment
  registerRlmHandler(
    IPC_CHANNELS.AB_GET_EXPERIMENT,
    AbExperimentIdPayloadSchema,
    (payload) => {
      const experiment = abEngine.getExperiment(payload.experimentId);
      if (!experiment) {
        throw new Error('Experiment not found');
      }
      return experiment;
    },
    deps,
  );

  // List experiments
  registerRlmHandler(
    IPC_CHANNELS.AB_LIST_EXPERIMENTS,
    AbListExperimentsPayloadSchema,
    (filter) => abEngine.listExperiments(filter),
    deps,
  );

  // Get variant for task
  registerRlmHandler(
    IPC_CHANNELS.AB_GET_VARIANT,
    AbGetVariantPayloadSchema,
    (payload) => abEngine.getVariant(payload.taskType, payload.sessionId),
    deps,
  );

  // Record outcome
  registerRlmHandler(
    IPC_CHANNELS.AB_RECORD_OUTCOME,
    AbRecordOutcomePayloadSchema,
    (payload) => abEngine.recordOutcome(payload.experimentId, payload.variantId, payload.outcome),
    deps,
  );

  // Get results
  registerRlmHandler(
    IPC_CHANNELS.AB_GET_RESULTS,
    AbExperimentIdPayloadSchema,
    (payload) => abEngine.getResults(payload.experimentId),
    deps,
  );

  // Get winner
  registerRlmHandler(
    IPC_CHANNELS.AB_GET_WINNER,
    AbExperimentIdPayloadSchema,
    (payload) => abEngine.getWinner(payload.experimentId),
    deps,
  );

  // Get stats
  registerRlmHandler(
    IPC_CHANNELS.AB_GET_STATS,
    AbEmptyPayloadSchema,
    () => abEngine.getStats(),
    deps,
  );

  // Configure
  registerRlmHandler(
    IPC_CHANNELS.AB_CONFIGURE,
    AbConfigurePayloadSchema,
    (config) => {
      abEngine.configure(config);
    },
    deps,
  );
}
