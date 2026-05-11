/**
 * Training Loop
 * GRPO-style reinforcement learning training for memory management
 * Based on Memory-R1 (arXiv:2508.19828) three-stage progressive training
 */

import { EventEmitter } from 'events';
import type {
  MemoryOperationLog,
  RetrievalLog,
  MemoryOperation,
} from '../../shared/types/memory-r1.types';
import type { TrainingStage } from '../../shared/types/unified-memory.types';

// ============ Training Types ============

export interface TrainingConfig {
  stage: TrainingStage;
  learningRate: number;
  batchSize: number;
  rewardDiscount: number; // gamma
  entropyCoefficient: number;
  valueCoefficient: number;
  maxGradNorm: number;
  warmupSteps: number;
  totalSteps: number;
}

export interface TrainingExample {
  id: string;
  input: string;
  operation: MemoryOperation;
  reward: number;
  timestamp: number;
  metadata: Record<string, unknown>;
}

export interface TrainingBatch {
  examples: TrainingExample[];
  stage: TrainingStage;
  batchId: string;
}

export interface TrainingMetrics {
  loss: number;
  policyLoss: number;
  valueLoss: number;
  entropy: number;
  rewardMean: number;
  rewardStd: number;
  gradNorm: number;
}

export interface EpochStats {
  epoch: number;
  stage: TrainingStage;
  metrics: TrainingMetrics;
  examples: number;
  duration: number;
}

export interface RewardSignal {
  taskId: string;
  success: boolean;
  score: number; // 0-1
  operationIds: string[];
  retrievalIds: string[];
}

// ============ Training Loop ============

export class TrainingLoop extends EventEmitter {
  private static instance: TrainingLoop | null = null;
  private config: TrainingConfig;
  private currentStage: TrainingStage = 1;
  private trainingBuffer: TrainingExample[] = [];
  private operationLogs: MemoryOperationLog[] = [];
  private retrievalLogs: RetrievalLog[] = [];
  private epochHistory: EpochStats[] = [];
  private isTraining = false;

  /**
   * Log-linear policy weights: one scalar per operation type.
   * π(op | context) ∝ exp(policyWeights[op])
   * Updated via GRPO gradient ascent each training batch.
   */
  private policyWeights: Record<MemoryOperation, number> = {
    ADD: 0.0,
    UPDATE: 0.0,
    DELETE: 0.0,
    NOOP: 0.0,
  };

  /**
   * Value baseline: exponential moving average of rewards.
   * Used to estimate state value V(s) ≈ E[r], reducing gradient variance.
   */
  private valueBias = 0.0;

  private defaultConfig: TrainingConfig = {
    stage: 1,
    learningRate: 1e-4,
    batchSize: 32,
    rewardDiscount: 0.99,
    entropyCoefficient: 0.01,
    valueCoefficient: 0.5,
    maxGradNorm: 0.5,
    warmupSteps: 100,
    totalSteps: 10000,
  };

  static getInstance(): TrainingLoop {
    if (!this.instance) {
      this.instance = new TrainingLoop();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
  }

  configure(config: Partial<TrainingConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.stage) {
      this.currentStage = config.stage;
    }
  }

  // ============ Stage Management ============

  getStage(): TrainingStage {
    return this.currentStage;
  }

  advanceStage(): boolean {
    if (this.currentStage < 3) {
      this.currentStage = (this.currentStage + 1) as TrainingStage;
      this.emit('stage:advanced', { newStage: this.currentStage });
      return true;
    }
    return false;
  }

  getStageDescription(): string {
    switch (this.currentStage) {
      case 1:
        return 'Stage 1: Basic memory operations (ADD, NOOP)';
      case 2:
        return 'Stage 2: Full operations (ADD, UPDATE, DELETE, NOOP)';
      case 3:
        return 'Stage 3: Optimized retrieval and context selection';
      default:
        return 'Unknown stage';
    }
  }

  // ============ Data Collection ============

  recordOperation(log: MemoryOperationLog): void {
    this.operationLogs.push(log);

    // Keep buffer manageable
    if (this.operationLogs.length > 10000) {
      this.operationLogs = this.operationLogs.slice(-5000);
    }

    this.emit('operation:recorded', log);
  }

  recordRetrieval(log: RetrievalLog): void {
    this.retrievalLogs.push(log);

    if (this.retrievalLogs.length > 10000) {
      this.retrievalLogs = this.retrievalLogs.slice(-5000);
    }

    this.emit('retrieval:recorded', log);
  }

  // ============ Reward Processing ============

  processReward(signal: RewardSignal): void {
    const reward = this.calculateReward(signal);

    // Update operation logs with rewards
    for (const opId of signal.operationIds) {
      const log = this.operationLogs.find(l => l.id === opId);
      if (log) {
        log.outcomeScore = reward;
        this.addTrainingExample({
          id: opId,
          input: log.reason,
          operation: log.operation,
          reward,
          timestamp: log.timestamp,
          metadata: { taskId: signal.taskId },
        });
      }
    }

    // Update retrieval logs with rewards
    for (const retId of signal.retrievalIds) {
      const log = this.retrievalLogs.find(l => l.id === retId);
      if (log) {
        log.retrievalQuality = this.calculateRetrievalQuality(log, signal);
      }
    }

    this.emit('reward:processed', { signal, reward });
  }

  private calculateReward(signal: RewardSignal): number {
    // Base reward from task success
    let reward = signal.success ? signal.score : -0.5;

    // Penalize excessive operations (encourage efficiency)
    const opCount = signal.operationIds.length;
    if (opCount > 5) {
      reward -= (opCount - 5) * 0.05;
    }

    // Clamp reward
    return Math.max(-1, Math.min(1, reward));
  }

  private calculateRetrievalQuality(log: RetrievalLog, signal: RewardSignal): number {
    // Quality based on how many retrieved memories were actually used
    const usedRatio = log.selectedIds.length / Math.max(log.retrievedIds.length, 1);

    // Combine with task success
    return usedRatio * 0.5 + (signal.success ? 0.5 : 0);
  }

  private addTrainingExample(example: TrainingExample): void {
    this.trainingBuffer.push(example);

    // Auto-trigger training when buffer is full
    if (this.trainingBuffer.length >= this.config.batchSize * 2 && !this.isTraining) {
      this.trainBatch().catch(err => {
        this.emit('training:error', { error: err.message });
      });
    }
  }

  // ============ Training ============

  async trainBatch(): Promise<TrainingMetrics | null> {
    if (this.isTraining) {
      return null;
    }

    if (this.trainingBuffer.length < this.config.batchSize) {
      return null;
    }

    this.isTraining = true;
    const startTime = Date.now();

    try {
      // Sample batch
      const batch = this.sampleBatch();

      this.emit('training:started', { batchId: batch.batchId, examples: batch.examples.length });

      // Compute metrics (placeholder - actual impl uses gradient updates)
      const metrics = await this.computeMetrics(batch);

      // Update weights (placeholder)
      await this.updateWeights(metrics);

      // Record epoch
      const stats: EpochStats = {
        epoch: this.epochHistory.length + 1,
        stage: this.currentStage,
        metrics,
        examples: batch.examples.length,
        duration: Date.now() - startTime,
      };

      this.epochHistory.push(stats);

      // Clear processed examples
      this.trainingBuffer = this.trainingBuffer.slice(batch.examples.length);

      this.emit('training:completed', stats);

      // Check for stage advancement
      this.checkStageAdvancement();

      return metrics;
    } finally {
      this.isTraining = false;
    }
  }

  private sampleBatch(): TrainingBatch {
    // Prioritize recent examples with rewards
    const withRewards = this.trainingBuffer.filter(e => e.reward !== 0);
    const sampled = withRewards.length >= this.config.batchSize
      ? withRewards.slice(0, this.config.batchSize)
      : this.trainingBuffer.slice(0, this.config.batchSize);

    return {
      examples: sampled,
      stage: this.currentStage,
      batchId: `batch-${Date.now()}`,
    };
  }

  private async computeMetrics(batch: TrainingBatch): Promise<TrainingMetrics> {
    const rewards = batch.examples.map(e => e.reward);
    const n = rewards.length || 1;
    const rewardMean = rewards.reduce((a, b) => a + b, 0) / n;
    const rewardVar = rewards.reduce((sum, r) => sum + (r - rewardMean) ** 2, 0) / n;
    const rewardStd = Math.sqrt(rewardVar) || 1;

    // Compute GRPO advantages per example
    const advantages = this.computeGroupAdvantages(batch);

    // Softmax policy distribution from current weights
    const softmax = this.computeSoftmax(this.policyWeights);

    // Policy loss: negative GRPO objective = -mean(advantage * log π(a))
    // For each example: advantage_i * (1 - softmax[op_i])  [diagonal of softmax gradient]
    let policyLossSum = 0;
    let gradSumSq = 0;
    const gradients: Record<MemoryOperation, number> = { ADD: 0, UPDATE: 0, DELETE: 0, NOOP: 0 };

    for (const example of batch.examples) {
      const adv = advantages.get(example.id) ?? 0;
      const op = example.operation;
      // GRPO gradient: adv * (e_op - softmax) — gradient of log π w.r.t. weights
      for (const key of Object.keys(softmax) as MemoryOperation[]) {
        const indicator = key === op ? 1 : 0;
        const g = adv * (indicator - softmax[key]);
        gradients[key] += g;
        gradSumSq += g * g;
      }
      // Policy loss contribution: -adv * log(softmax[op])
      const logProb = Math.log(Math.max(softmax[op], 1e-10));
      policyLossSum += -adv * logProb;
    }

    const policyLoss = policyLossSum / n;

    // Value loss: variance of rewards (measures how well baseline tracks actual returns)
    const valueLoss = rewardVar;

    // Entropy of the softmax distribution: -sum(p * log(p))
    const entropy = -Object.values(softmax).reduce(
      (sum, p) => sum + (p > 0 ? p * Math.log(p) : 0),
      0,
    );

    // Gradient norm (L2) of the accumulated gradient before the update step
    const gradNorm = Math.min(Math.sqrt(gradSumSq / n), this.config.maxGradNorm);

    // Combined loss (policy + value coefficient * value loss)
    const loss = policyLoss + this.config.valueCoefficient * valueLoss
      - this.config.entropyCoefficient * entropy;

    return {
      loss: Math.max(0, loss),
      policyLoss: Math.max(0, policyLoss),
      valueLoss,
      entropy,
      rewardMean,
      rewardStd,
      gradNorm,
    };
  }

  private async updateWeights(metrics: TrainingMetrics): Promise<void> {
    const batch = this.trainingBuffer.slice(0, this.config.batchSize);
    if (batch.length === 0) return;

    const fakeBatch: TrainingBatch = { examples: batch, stage: this.currentStage, batchId: 'update' };
    const advantages = this.computeGroupAdvantages(fakeBatch);
    const softmax = this.computeSoftmax(this.policyWeights);
    const n = batch.length || 1;

    // Accumulate GRPO policy gradients
    const gradients: Record<MemoryOperation, number> = { ADD: 0, UPDATE: 0, DELETE: 0, NOOP: 0 };
    for (const example of batch) {
      const adv = advantages.get(example.id) ?? 0;
      const op = example.operation;
      for (const key of Object.keys(softmax) as MemoryOperation[]) {
        const indicator = key === op ? 1 : 0;
        gradients[key] += adv * (indicator - softmax[key]);
      }
    }

    // Clip gradient by maxGradNorm
    const rawNorm = Math.sqrt(
      Object.values(gradients).reduce((s, g) => s + g * g, 0),
    );
    const clipScale = rawNorm > this.config.maxGradNorm ? this.config.maxGradNorm / rawNorm : 1;

    // Gradient ascent step (maximise reward) on log-linear policy weights
    for (const key of Object.keys(gradients) as MemoryOperation[]) {
      this.policyWeights[key] += this.config.learningRate * (gradients[key] / n) * clipScale;
    }

    // Update EMA value baseline
    const alpha = 0.05;
    this.valueBias = alpha * metrics.rewardMean + (1 - alpha) * this.valueBias;

    // Log updated policy distribution
    const updatedSoftmax = this.computeSoftmax(this.policyWeights);
    this.emit('weights:updated', {
      policyWeights: { ...this.policyWeights },
      policyDistribution: updatedSoftmax,
      valueBias: this.valueBias,
      gradNorm: metrics.gradNorm,
    });
  }

  /**
   * Compute softmax distribution over operation types from log-linear weights.
   */
  private computeSoftmax(weights: Record<MemoryOperation, number>): Record<MemoryOperation, number> {
    const ops = Object.keys(weights) as MemoryOperation[];
    const maxW = Math.max(...ops.map(op => weights[op]));
    const exps = ops.map(op => ({ op, e: Math.exp(weights[op] - maxW) }));
    const sum = exps.reduce((s, { e }) => s + e, 0) || 1;
    const result = {} as Record<MemoryOperation, number>;
    for (const { op, e } of exps) {
      result[op] = e / sum;
    }
    return result;
  }

  private checkStageAdvancement(): void {
    // Check if we should advance to next stage
    const recentEpochs = this.epochHistory.slice(-10);

    if (recentEpochs.length < 10) return;

    const avgReward = recentEpochs.reduce((sum, e) => sum + e.metrics.rewardMean, 0) / 10;

    // Stage advancement thresholds
    const thresholds: Record<TrainingStage, number> = {
      1: 0.5,
      2: 0.6,
      3: 0.7,
    };

    if (avgReward >= thresholds[this.currentStage]) {
      this.advanceStage();
    }
  }

  // ============ GRPO-Specific Methods ============

  computeGroupAdvantages(batch: TrainingBatch): Map<string, number> {
    // Group-Relative Policy Optimization
    const advantages = new Map<string, number>();

    // Group by operation type
    const groups = new Map<MemoryOperation, TrainingExample[]>();
    for (const example of batch.examples) {
      const group = groups.get(example.operation) || [];
      group.push(example);
      groups.set(example.operation, group);
    }

    // Compute relative advantages within each group
    for (const [_op, examples] of groups) {
      const rewards = examples.map(e => e.reward);
      const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length;
      const std = Math.sqrt(
        rewards.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / rewards.length
      ) || 1;

      for (const example of examples) {
        const advantage = (example.reward - mean) / std;
        advantages.set(example.id, advantage);
      }
    }

    return advantages;
  }

  // ============ Statistics ============

  getStats(): {
    currentStage: TrainingStage;
    totalEpochs: number;
    bufferSize: number;
    recentMetrics: TrainingMetrics | null;
    avgRewardByStage: Record<TrainingStage, number>;
  } {
    const recentMetrics = this.epochHistory.length > 0
      ? this.epochHistory[this.epochHistory.length - 1].metrics
      : null;

    const avgRewardByStage: Record<TrainingStage, number> = { 1: 0, 2: 0, 3: 0 };
    const countByStage: Record<TrainingStage, number> = { 1: 0, 2: 0, 3: 0 };

    for (const epoch of this.epochHistory) {
      avgRewardByStage[epoch.stage] += epoch.metrics.rewardMean;
      countByStage[epoch.stage]++;
    }

    for (const stage of [1, 2, 3] as TrainingStage[]) {
      if (countByStage[stage] > 0) {
        avgRewardByStage[stage] /= countByStage[stage];
      }
    }

    return {
      currentStage: this.currentStage,
      totalEpochs: this.epochHistory.length,
      bufferSize: this.trainingBuffer.length,
      recentMetrics,
      avgRewardByStage,
    };
  }

  getEpochHistory(limit?: number): EpochStats[] {
    const history = [...this.epochHistory];
    return limit ? history.slice(-limit) : history;
  }

  // ============ Persistence ============

  exportState(): {
    config: TrainingConfig;
    stage: TrainingStage;
    epochHistory: EpochStats[];
    buffer: TrainingExample[];
  } {
    return {
      config: this.config,
      stage: this.currentStage,
      epochHistory: this.epochHistory,
      buffer: this.trainingBuffer,
    };
  }

  importState(state: {
    config?: Partial<TrainingConfig>;
    stage?: TrainingStage;
    epochHistory?: EpochStats[];
    buffer?: TrainingExample[];
  }): void {
    if (state.config) {
      this.configure(state.config);
    }
    if (state.stage) {
      this.currentStage = state.stage;
    }
    if (state.epochHistory) {
      this.epochHistory = state.epochHistory;
    }
    if (state.buffer) {
      this.trainingBuffer = state.buffer;
    }

    this.emit('state:imported');
  }
}

// Export singleton getter
export function getTrainingLoop(): TrainingLoop {
  return TrainingLoop.getInstance();
}
