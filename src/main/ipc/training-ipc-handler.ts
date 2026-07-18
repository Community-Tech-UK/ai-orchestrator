/**
 * Training IPC Handler
 *
 * Handle IPC communication for GRPO training dashboard:
 * - Training statistics
 * - Reward data for charts
 * - Strategy comparisons
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import type { GRPOConfig, TrainingOutcome, GRPOBatch, TrainingStats } from '../learning/grpo-trainer';
import {
  TrainingConfigPayloadSchema,
  TrainingDashboardListPayloadSchema,
  TrainingEmptyPayloadSchema,
  TrainingGetStrategiesPayloadSchema,
  TrainingImportDataPayloadSchema,
  TrainingInsightIdPayloadSchema,
  TrainingRecordOutcomePayloadSchema,
  TrainingTopStrategiesPayloadSchema,
  TrainingUpdateConfigPayloadSchema,
} from '@contracts/schemas/provider';
import { validatedHandler, type IpcResponse } from './validated-handler';

// Define training IPC channels
export const TRAINING_IPC_CHANNELS = {
  GET_TRAINING_STATS: 'training:get-stats',
  GET_REWARD_DATA: 'training:get-reward-data',
  GET_ADVANTAGE_DATA: 'training:get-advantage-data',
  GET_STRATEGIES: 'training:get-strategies',
  GET_CONFIG: 'training:get-config',
  UPDATE_CONFIG: 'training:update-config',
  EXPORT_DATA: 'training:export-data',
  GET_REWARD_TREND: 'training:get-reward-trend',
} as const;

// Response types
export interface TrainingStatsResponse {
  totalOutcomes: number;
  totalBatches: number;
  averageReward: number;
  averageAdvantage: number;
  lastUpdated: number;
}

export interface RewardDataPoint {
  step: number;
  reward: number;
}

export interface StrategyData {
  strategy: string;
  avgReward: number;
  count: number;
}

export interface RewardTrendResponse {
  improving: boolean;
  slope: number;
  recent: number[];
}

/**
 * Register training IPC handlers
 */
interface TrainingHandlerDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

export function registerTrainingHandlers(deps: TrainingHandlerDeps = {}): void {
  // Get training statistics
  registerTrainingHandler(
    TRAINING_IPC_CHANNELS.GET_TRAINING_STATS,
    TrainingEmptyPayloadSchema,
    async () => {
      const trainer = await getTrainer();
      const stats = trainer.getStats();
      return {
        totalOutcomes: stats.totalOutcomes,
        totalBatches: stats.totalBatches,
        averageReward: stats.avgReward,
        averageAdvantage: stats.avgAdvantage,
        lastUpdated: Date.now(),
      } satisfies TrainingStatsResponse;
    },
    deps,
  );

  // Get reward data for charts
  registerTrainingHandler(
    TRAINING_IPC_CHANNELS.GET_REWARD_DATA,
    TrainingDashboardListPayloadSchema,
    async () => {
      const stats = (await getTrainer()).getStats();
      return stats.rewardTrend.map((reward, index) => ({
          step: index,
          reward,
      })) satisfies RewardDataPoint[];
    },
    deps,
  );

  // Get advantage histogram data
  registerTrainingHandler(
    TRAINING_IPC_CHANNELS.GET_ADVANTAGE_DATA,
    TrainingEmptyPayloadSchema,
    async () => {
      const exported = (await getTrainer()).exportTrainingData();
      const bins = new Map<number, number>();
      const binWidth = 0.5;
      for (const batch of exported.batches) {
        for (const advantage of batch.advantages) {
          const binKey = Math.round(advantage / binWidth) * binWidth;
          bins.set(binKey, (bins.get(binKey) || 0) + 1);
        }
      }
      return Array.from(bins.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value - b.value);
    },
    deps,
  );

  // Get strategies
  registerTrainingHandler(
    TRAINING_IPC_CHANNELS.GET_STRATEGIES,
    TrainingGetStrategiesPayloadSchema,
    async (payload) => (await getTrainer()).getTopStrategies(payload?.limit ?? 10),
    deps,
  );

  // Get config
  registerTrainingHandler(
    TRAINING_IPC_CHANNELS.GET_CONFIG,
    TrainingEmptyPayloadSchema,
    async () => (await getTrainer()).getConfig(),
    deps,
  );

  // Update config
  registerTrainingHandler(
    TRAINING_IPC_CHANNELS.UPDATE_CONFIG,
    TrainingUpdateConfigPayloadSchema,
    async (payload) => (await getTrainer()).configure(payload.config),
    deps,
  );

  // Export data
  registerTrainingHandler(
    TRAINING_IPC_CHANNELS.EXPORT_DATA,
    TrainingEmptyPayloadSchema,
    async () => {
      const data = (await getTrainer()).exportTrainingData();
      return {
        outcomes: data.outcomes,
        batches: data.batches,
        stats: {
          ...data.stats,
          strategyPerformance: Object.fromEntries(data.stats.strategyPerformance),
        },
      } satisfies {
        outcomes: TrainingOutcome[];
        batches: GRPOBatch[];
        stats: Omit<TrainingStats, 'strategyPerformance'> & {
          strategyPerformance: Record<string, { avgReward: number; count: number }>;
        };
      };
    },
    deps,
  );

  // Get reward trend
  registerTrainingHandler(
    TRAINING_IPC_CHANNELS.GET_REWARD_TREND,
    TrainingEmptyPayloadSchema,
    async () => (await getTrainer()).getRewardTrend() satisfies RewardTrendResponse,
    deps,
  );

  // Compatibility aliases used by renderer domain IPC services.
  registerTrainingHandler(
    IPC_CHANNELS.TRAINING_RECORD_OUTCOME,
    TrainingRecordOutcomePayloadSchema,
    async (payload) => (await getTrainer()).recordOutcome(payload),
    deps,
  );

  registerTrainingHandler(
    IPC_CHANNELS.TRAINING_IMPORT_DATA,
    TrainingImportDataPayloadSchema,
    async (payload) => (await getTrainer()).importTrainingData(payload),
    deps,
  );

  registerTrainingHandler(
    IPC_CHANNELS.TRAINING_GET_TREND,
    TrainingEmptyPayloadSchema,
    async () => (await getTrainer()).getRewardTrend() satisfies RewardTrendResponse,
    deps,
  );

  registerTrainingHandler(
    IPC_CHANNELS.TRAINING_GET_TOP_STRATEGIES,
    TrainingTopStrategiesPayloadSchema,
    async (limit) => (await getTrainer()).getTopStrategies(limit ?? 10),
    deps,
  );

  registerTrainingHandler(
    IPC_CHANNELS.TRAINING_CONFIGURE,
    TrainingConfigPayloadSchema,
    async (config) => (await getTrainer()).configure(config),
    deps,
  );

  // Enhanced dashboard handlers.
  registerTrainingHandler(
    IPC_CHANNELS.TRAINING_GET_AGENT_PERFORMANCE,
    TrainingEmptyPayloadSchema,
    async () => (await getTrainer()).getAgentPerformance(),
    deps,
  );

  registerTrainingHandler(
    IPC_CHANNELS.TRAINING_GET_PATTERNS,
    TrainingDashboardListPayloadSchema,
    async () => (await getTrainer()).getPatterns(),
    deps,
  );

  registerTrainingHandler(
    IPC_CHANNELS.TRAINING_GET_INSIGHTS,
    TrainingEmptyPayloadSchema,
    async () => (await getTrainer()).getInsights(),
    deps,
  );

  registerTrainingHandler(
    IPC_CHANNELS.TRAINING_APPLY_INSIGHT,
    TrainingInsightIdPayloadSchema,
    async (payload) => {
      if (!(await getTrainer()).applyInsight(payload.insightId)) {
        throw new Error('Training insight not found');
      }
      return { insightId: payload.insightId };
    },
    deps,
  );

  registerTrainingHandler(
    IPC_CHANNELS.TRAINING_DISMISS_INSIGHT,
    TrainingInsightIdPayloadSchema,
    async (payload) => {
      if (!(await getTrainer()).dismissInsight(payload.insightId)) {
        throw new Error('Training insight not found');
      }
      return { insightId: payload.insightId };
    },
    deps,
  );
}

function registerTrainingHandler<TPayload, TResult>(
  channel: string,
  schema: z.ZodSchema<TPayload>,
  call: (payload: TPayload) => TResult | Promise<TResult>,
  deps: TrainingHandlerDeps,
): void {
  ipcMain.handle(
    channel,
    validatedHandler(
      channel,
      schema,
      async (payload) => {
        const data = await call(payload);
        return data === undefined
          ? { success: true }
          : { success: true, data };
      },
      {
        ensureTrustedSender: deps.ensureTrustedSender,
        errorCode: `${channel.replace(/[:-]/g, '_').toUpperCase()}_FAILED`,
      },
    ),
  );
}

async function getTrainer() {
  const { getGRPOTrainer } = await import('../learning/grpo-trainer');
  return getGRPOTrainer();
}
