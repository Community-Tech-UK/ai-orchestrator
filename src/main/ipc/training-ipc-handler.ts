/**
 * Training IPC Handler
 *
 * Handle IPC communication for GRPO training dashboard:
 * - Training statistics
 * - Reward data for charts
 * - Strategy comparisons
 */

import { ipcMain } from 'electron';
import type { IpcResponse, ErrorInfo } from '../../shared/types/ipc.types';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import type { GRPOConfig, TrainingOutcome, GRPOBatch, TrainingStats } from '../learning/grpo-trainer';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  TrainingGetStrategiesPayloadSchema,
  TrainingUpdateConfigPayloadSchema,
} from '@contracts/schemas/provider';

// Helper function to create ErrorInfo from Error
function createErrorInfo(error: unknown, code: string = 'TRAINING_ERROR'): ErrorInfo {
  const err = error as Error;
  return {
    code,
    message: err.message || 'Unknown error',
    stack: err.stack,
    timestamp: Date.now(),
  };
}

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
export function registerTrainingHandlers(): void {
  // Get training statistics
  ipcMain.handle(
    TRAINING_IPC_CHANNELS.GET_TRAINING_STATS,
    async (): Promise<IpcResponse<TrainingStatsResponse>> => {
      try {
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const trainer = getGRPOTrainer();
        const stats = trainer.getStats();

        return {
          success: true,
          data: {
            totalOutcomes: stats.totalOutcomes,
            totalBatches: stats.totalBatches,
            averageReward: stats.avgReward,
            averageAdvantage: stats.avgAdvantage,
            lastUpdated: Date.now(),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: createErrorInfo(error),
        };
      }
    }
  );

  // Get reward data for charts
  ipcMain.handle(
    TRAINING_IPC_CHANNELS.GET_REWARD_DATA,
    async (): Promise<IpcResponse<RewardDataPoint[]>> => {
      try {
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const trainer = getGRPOTrainer();
        const stats = trainer.getStats();

        // Convert reward trend to chart data
        const rewardData: RewardDataPoint[] = stats.rewardTrend.map((reward, index) => ({
          step: index,
          reward,
        }));

        return {
          success: true,
          data: rewardData,
        };
      } catch (error) {
        return {
          success: false,
          error: createErrorInfo(error),
        };
      }
    }
  );

  // Get advantage histogram data
  ipcMain.handle(
    TRAINING_IPC_CHANNELS.GET_ADVANTAGE_DATA,
    async (): Promise<IpcResponse<{ value: number; count: number }[]>> => {
      try {
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const trainer = getGRPOTrainer();
        const exported = trainer.exportTrainingData();

        // Create histogram from batch advantages
        const bins = new Map<number, number>();
        const binWidth = 0.5;

        for (const batch of exported.batches) {
          for (const advantage of batch.advantages) {
            const binKey = Math.round(advantage / binWidth) * binWidth;
            bins.set(binKey, (bins.get(binKey) || 0) + 1);
          }
        }

        const data = Array.from(bins.entries())
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => a.value - b.value);

        return {
          success: true,
          data,
        };
      } catch (error) {
        return {
          success: false,
          error: createErrorInfo(error),
        };
      }
    }
  );

  // Get strategies
  ipcMain.handle(
    TRAINING_IPC_CHANNELS.GET_STRATEGIES,
    async (_event, payload: unknown): Promise<IpcResponse<StrategyData[]>> => {
      try {
        const validated = validateIpcPayload(TrainingGetStrategiesPayloadSchema, payload, 'GET_STRATEGIES');
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const trainer = getGRPOTrainer();
        const strategies = trainer.getTopStrategies(validated?.limit || 10);

        return {
          success: true,
          data: strategies,
        };
      } catch (error) {
        return {
          success: false,
          error: createErrorInfo(error),
        };
      }
    }
  );

  // Get config
  ipcMain.handle(
    TRAINING_IPC_CHANNELS.GET_CONFIG,
    async (): Promise<IpcResponse<GRPOConfig>> => {
      try {
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const trainer = getGRPOTrainer();
        const config = trainer.getConfig();

        return {
          success: true,
          data: config,
        };
      } catch (error) {
        return {
          success: false,
          error: createErrorInfo(error),
        };
      }
    }
  );

  // Update config
  ipcMain.handle(
    TRAINING_IPC_CHANNELS.UPDATE_CONFIG,
    async (_event, payload: unknown): Promise<IpcResponse<void>> => {
      try {
        const validated = validateIpcPayload(TrainingUpdateConfigPayloadSchema, payload, 'UPDATE_CONFIG');
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const trainer = getGRPOTrainer();
        trainer.configure(validated.config as Partial<GRPOConfig>);

        return {
          success: true,
          data: undefined,
        };
      } catch (error) {
        return {
          success: false,
          error: createErrorInfo(error),
        };
      }
    }
  );

  // Export data
  ipcMain.handle(
    TRAINING_IPC_CHANNELS.EXPORT_DATA,
    async (): Promise<IpcResponse<{ outcomes: TrainingOutcome[]; batches: GRPOBatch[]; stats: Omit<TrainingStats, 'strategyPerformance'> & { strategyPerformance: Record<string, { avgReward: number; count: number }> } }>> => {
      try {
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const trainer = getGRPOTrainer();
        const data = trainer.exportTrainingData();

        // Convert Map to object for serialization
        return {
          success: true,
          data: {
            outcomes: data.outcomes,
            batches: data.batches,
            stats: {
              ...data.stats,
              strategyPerformance: Object.fromEntries(data.stats.strategyPerformance),
            },
          },
        };
      } catch (error) {
        return {
          success: false,
          error: createErrorInfo(error),
        };
      }
    }
  );

  // Get reward trend
  ipcMain.handle(
    TRAINING_IPC_CHANNELS.GET_REWARD_TREND,
    async (): Promise<IpcResponse<RewardTrendResponse>> => {
      try {
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const trainer = getGRPOTrainer();
        const trend = trainer.getRewardTrend();

        return {
          success: true,
          data: trend,
        };
      } catch (error) {
        return {
          success: false,
          error: createErrorInfo(error),
        };
      }
    }
  );

  // Compatibility aliases for channels declared in shared IPC types.
  // These are used by renderer domain IPC services.

  ipcMain.handle(
    IPC_CHANNELS.TRAINING_RECORD_OUTCOME,
    async (_event, payload: unknown): Promise<IpcResponse<void>> => {
      try {
        const outcome = payload as Partial<TrainingOutcome>;
        if (
          !outcome ||
          typeof outcome.taskId !== 'string' ||
          typeof outcome.prompt !== 'string' ||
          typeof outcome.response !== 'string' ||
          typeof outcome.reward !== 'number'
        ) {
          return {
            success: false,
            error: createErrorInfo(
              new Error('Invalid training outcome payload'),
              'TRAINING_INVALID_PAYLOAD'
            ),
          };
        }

        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        getGRPOTrainer().recordOutcome({
          taskId: outcome.taskId,
          prompt: outcome.prompt,
          response: outcome.response,
          reward: outcome.reward,
          strategy: outcome.strategy,
          context: outcome.context,
        });

        return { success: true, data: undefined };
      } catch (error) {
        return { success: false, error: createErrorInfo(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TRAINING_IMPORT_DATA,
    async (_event, payload: unknown): Promise<IpcResponse<void>> => {
      try {
        const data = payload as { outcomes?: TrainingOutcome[]; batches?: GRPOBatch[] };
        if (!data || !Array.isArray(data.outcomes) || !Array.isArray(data.batches)) {
          return {
            success: false,
            error: createErrorInfo(
              new Error('Invalid training import payload'),
              'TRAINING_INVALID_PAYLOAD'
            ),
          };
        }

        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        getGRPOTrainer().importTrainingData({
          outcomes: data.outcomes,
          batches: data.batches,
        });

        return { success: true, data: undefined };
      } catch (error) {
        return { success: false, error: createErrorInfo(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TRAINING_GET_TREND,
    async (): Promise<IpcResponse<RewardTrendResponse>> => {
      try {
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const trend = getGRPOTrainer().getRewardTrend();
        return { success: true, data: trend };
      } catch (error) {
        return { success: false, error: createErrorInfo(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TRAINING_GET_TOP_STRATEGIES,
    async (_event, payload: unknown): Promise<IpcResponse<StrategyData[]>> => {
      try {
        const limit = typeof payload === 'number' ? payload : undefined;
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const strategies = getGRPOTrainer().getTopStrategies(limit ?? 10);
        return { success: true, data: strategies };
      } catch (error) {
        return { success: false, error: createErrorInfo(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TRAINING_CONFIGURE,
    async (_event, payload: unknown): Promise<IpcResponse<void>> => {
      try {
        const config = payload as Partial<GRPOConfig>;
        if (!config || typeof config !== 'object') {
          return {
            success: false,
            error: createErrorInfo(
              new Error('Invalid training config payload'),
              'TRAINING_INVALID_PAYLOAD'
            ),
          };
        }

        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        getGRPOTrainer().configure(config);
        return { success: true, data: undefined };
      } catch (error) {
        return { success: false, error: createErrorInfo(error) };
      }
    }
  );

  // ============ Enhanced Dashboard Handlers ============

  // Get agent/task performance metrics
  ipcMain.handle(
    'training:get-agent-performance',
    async (): Promise<IpcResponse> => {
      try {
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const metrics = getGRPOTrainer().getAgentPerformance();
        return { success: true, data: metrics };
      } catch (error) {
        return { success: false, error: createErrorInfo(error) };
      }
    }
  );

  // Get detected training patterns
  ipcMain.handle(
    'training:get-patterns',
    async (): Promise<IpcResponse> => {
      try {
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const patterns = getGRPOTrainer().getPatterns();
        return { success: true, data: patterns };
      } catch (error) {
        return { success: false, error: createErrorInfo(error) };
      }
    }
  );

  // Get actionable training insights
  ipcMain.handle(
    'training:get-insights',
    async (): Promise<IpcResponse> => {
      try {
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const insights = getGRPOTrainer().getInsights();
        return { success: true, data: insights };
      } catch (error) {
        return { success: false, error: createErrorInfo(error) };
      }
    }
  );

  // Apply an insight (mark as applied)
  ipcMain.handle(
    'training:apply-insight',
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = payload as { insightId?: string } | undefined;
        if (!data?.insightId) {
          return { success: false, error: createErrorInfo(new Error('insightId required'), 'TRAINING_INVALID_PAYLOAD') };
        }
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const applied = getGRPOTrainer().applyInsight(data.insightId);
        return { success: applied, data: { insightId: data.insightId } };
      } catch (error) {
        return { success: false, error: createErrorInfo(error) };
      }
    }
  );

  // Dismiss an insight
  ipcMain.handle(
    'training:dismiss-insight',
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = payload as { insightId?: string } | undefined;
        if (!data?.insightId) {
          return { success: false, error: createErrorInfo(new Error('insightId required'), 'TRAINING_INVALID_PAYLOAD') };
        }
        const { getGRPOTrainer } = await import('../learning/grpo-trainer');
        const dismissed = getGRPOTrainer().dismissInsight(data.insightId);
        return { success: dismissed, data: { insightId: data.insightId } };
      } catch (error) {
        return { success: false, error: createErrorInfo(error) };
      }
    }
  );
}
