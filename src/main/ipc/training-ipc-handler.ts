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
import type { GRPOConfig, TrainingOutcome, GRPOBatch, TrainingStats } from '../training/grpo-trainer';

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
        const { getGRPOTrainer } = await import('../training/grpo-trainer');
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
        const { getGRPOTrainer } = await import('../training/grpo-trainer');
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
        const { getGRPOTrainer } = await import('../training/grpo-trainer');
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
    async (_event, payload?: { limit?: number }): Promise<IpcResponse<StrategyData[]>> => {
      try {
        const { getGRPOTrainer } = await import('../training/grpo-trainer');
        const trainer = getGRPOTrainer();
        const strategies = trainer.getTopStrategies(payload?.limit || 10);

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
        const { getGRPOTrainer } = await import('../training/grpo-trainer');
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
    async (_event, payload: { config: Partial<import('../training/grpo-trainer').GRPOConfig> }): Promise<IpcResponse<void>> => {
      try {
        const { getGRPOTrainer } = await import('../training/grpo-trainer');
        const trainer = getGRPOTrainer();
        trainer.configure(payload.config);

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
        const { getGRPOTrainer } = await import('../training/grpo-trainer');
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
        const { getGRPOTrainer } = await import('../training/grpo-trainer');
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
}
