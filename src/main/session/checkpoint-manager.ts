/**
 * Checkpoint Manager
 *
 * Bridges error recovery checkpoints with session continuity:
 * - Transaction logging for all significant actions
 * - Recovery-aware checkpoints at key decision points
 * - Automatic checkpoint creation based on error recovery signals
 * - State restoration wizard support
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
  SessionCheckpoint,
  CheckpointType,
  RecoveryAction,
} from '../../shared/types/error-recovery.types';
import { ErrorRecoveryManager } from '../core/error-recovery';
import {
  SessionContinuityManager,
  getSessionContinuityManager,
  SessionSnapshot,
} from './session-continuity';
import { getLogger } from '../logging/logger';

const logger = getLogger('CheckpointManager');

/**
 * Transaction log entry
 */
export interface TransactionLogEntry {
  id: string;
  timestamp: number;
  sessionId: string;
  type: TransactionType;
  action: string;
  details: Record<string, unknown>;
  checkpointId?: string;
  success: boolean;
  error?: string;
  rollbackData?: unknown;
}

/**
 * Transaction types
 */
export enum TransactionType {
  /** File modification */
  FILE_OPERATION = 'file_operation',
  /** Tool execution */
  TOOL_EXECUTION = 'tool_execution',
  /** Model switch */
  MODEL_SWITCH = 'model_switch',
  /** Provider failover */
  PROVIDER_FAILOVER = 'provider_failover',
  /** Context compaction */
  CONTEXT_COMPACTION = 'context_compaction',
  /** Session state change */
  SESSION_STATE = 'session_state',
  /** Child instance spawn */
  CHILD_SPAWN = 'child_spawn',
  /** Memory operation */
  MEMORY_OPERATION = 'memory_operation',
  /** Configuration change */
  CONFIG_CHANGE = 'config_change',
  /** Error recovery action */
  RECOVERY_ACTION = 'recovery_action',
}

/**
 * Checkpoint manager configuration
 */
export interface CheckpointManagerConfig {
  /** Enable transaction logging */
  enableTransactionLog: boolean;
  /** Maximum transaction log entries to keep in memory */
  maxLogEntriesInMemory: number;
  /** Maximum transaction log file size (bytes) */
  maxLogFileSize: number;
  /** Create checkpoint before risky operations */
  checkpointBeforeRisky: boolean;
  /** Operations considered risky */
  riskyOperations: TransactionType[];
  /** Minimum time between auto-checkpoints (ms) */
  minCheckpointIntervalMs: number;
  /** Enable rollback support */
  enableRollback: boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointManagerConfig = {
  enableTransactionLog: true,
  maxLogEntriesInMemory: 1000,
  maxLogFileSize: 10 * 1024 * 1024, // 10MB
  checkpointBeforeRisky: true,
  riskyOperations: [
    TransactionType.FILE_OPERATION,
    TransactionType.TOOL_EXECUTION,
    TransactionType.MODEL_SWITCH,
    TransactionType.PROVIDER_FAILOVER,
    TransactionType.CONTEXT_COMPACTION,
  ],
  minCheckpointIntervalMs: 30000, // 30 seconds
  enableRollback: true,
};

/**
 * Recovery wizard step
 */
export interface RecoveryWizardStep {
  type: 'info' | 'choice' | 'confirm';
  title: string;
  description: string;
  options?: {
    id: string;
    label: string;
    description: string;
    recommended?: boolean;
  }[];
  data?: Record<string, unknown>;
}

/**
 * Recovery wizard result
 */
export interface RecoveryWizardResult {
  action: 'restore' | 'discard' | 'partial_restore' | 'cancel';
  checkpointId?: string;
  selectedOptions?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Checkpoint Manager
 *
 * Provides advanced checkpoint and transaction logging capabilities.
 */
export class CheckpointManager extends EventEmitter {
  private static instance: CheckpointManager | null = null;

  private config: CheckpointManagerConfig;
  private errorRecovery: ErrorRecoveryManager;
  private continuity: SessionContinuityManager;
  private transactionLog: TransactionLogEntry[] = [];
  private logDir: string;
  private lastCheckpointTime = new Map<string, number>();
  private pendingTransactions = new Map<string, TransactionLogEntry>();

  private constructor() {
    super();
    this.config = { ...DEFAULT_CHECKPOINT_CONFIG };
    this.errorRecovery = ErrorRecoveryManager.getInstance();
    this.continuity = getSessionContinuityManager();

    const userData = app?.getPath?.('userData') || path.join(process.cwd(), '.checkpoint-data');
    this.logDir = path.join(userData, 'transaction-logs');

    this.ensureDirectories();
    this.setupErrorRecoveryListeners();
  }

  static getInstance(): CheckpointManager {
    if (!CheckpointManager.instance) {
      CheckpointManager.instance = new CheckpointManager();
    }
    return CheckpointManager.instance;
  }

  static _resetForTesting(): void {
    CheckpointManager.instance = null;
  }

  /**
   * Configure the checkpoint manager
   */
  configure(config: Partial<CheckpointManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): CheckpointManagerConfig {
    return { ...this.config };
  }

  /**
   * Begin a transaction (call before risky operation)
   */
  async beginTransaction(
    sessionId: string,
    type: TransactionType,
    action: string,
    details: Record<string, unknown> = {},
    rollbackData?: unknown
  ): Promise<string> {
    const transactionId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const entry: TransactionLogEntry = {
      id: transactionId,
      timestamp: Date.now(),
      sessionId,
      type,
      action,
      details,
      success: false, // Will be updated on commit
      rollbackData,
    };

    this.pendingTransactions.set(transactionId, entry);

    // Create checkpoint for risky operations
    if (
      this.config.checkpointBeforeRisky &&
      this.config.riskyOperations.includes(type)
    ) {
      const checkpoint = await this.createCheckpoint(
        sessionId,
        CheckpointType.PRE_OPERATION,
        `Before ${action}`
      );
      if (checkpoint) {
        entry.checkpointId = checkpoint.id;
      }
    }

    this.emit('transaction:started', entry);
    return transactionId;
  }

  /**
   * Commit a transaction (call after successful operation)
   */
  commitTransaction(transactionId: string, additionalDetails?: Record<string, unknown>): void {
    const entry = this.pendingTransactions.get(transactionId);
    if (!entry) {
      logger.warn('Transaction not found', { transactionId });
      return;
    }

    entry.success = true;
    if (additionalDetails) {
      entry.details = { ...entry.details, ...additionalDetails };
    }

    this.addToLog(entry);
    this.pendingTransactions.delete(transactionId);

    // Create post-operation checkpoint for risky operations
    if (
      this.config.checkpointBeforeRisky &&
      this.config.riskyOperations.includes(entry.type)
    ) {
      void this.createCheckpoint(
        entry.sessionId,
        CheckpointType.POST_OPERATION,
        `After ${entry.action}`
      );
    }

    this.emit('transaction:committed', entry);
  }

  /**
   * Rollback a transaction (call on failure)
   */
  rollbackTransaction(transactionId: string, error?: Error): void {
    const entry = this.pendingTransactions.get(transactionId);
    if (!entry) {
      logger.warn('Transaction not found', { transactionId });
      return;
    }

    entry.success = false;
    entry.error = error?.message || 'Unknown error';

    this.addToLog(entry);
    this.pendingTransactions.delete(transactionId);

    // Emit event for potential rollback handling
    this.emit('transaction:rolled_back', {
      entry,
      rollbackData: entry.rollbackData,
      checkpointId: entry.checkpointId,
    });

    // Create error recovery checkpoint
    void this.createCheckpoint(
      entry.sessionId,
      CheckpointType.ERROR_RECOVERY,
      `Error during ${entry.action}`
    );
  }

  /**
   * Create a checkpoint for a session.
   * Awaits the continuity snapshot before storing the checkpoint so the
   * checkpoint is never written with empty/placeholder state.
   * Returns null if the rate-limit interval has not elapsed.
   */
  async createCheckpoint(
    sessionId: string,
    type: CheckpointType,
    description?: string
  ): Promise<SessionCheckpoint | null> {
    // Check minimum interval
    const lastTime = this.lastCheckpointTime.get(sessionId) || 0;
    if (
      type !== CheckpointType.MANUAL &&
      Date.now() - lastTime < this.config.minCheckpointIntervalMs
    ) {
      return null;
    }

    this.lastCheckpointTime.set(sessionId, Date.now());

    // Create snapshot FIRST so the checkpoint is populated with real data.
    let snapshot: SessionSnapshot | null = null;
    try {
      snapshot = await this.continuity.createSnapshot(
        sessionId,
        description || `Checkpoint: ${type}`,
        undefined,
        type === CheckpointType.PERIODIC ? 'auto' : 'checkpoint'
      );
    } catch (error) {
      logger.warn('Failed to create snapshot for checkpoint', {
        sessionId,
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Build conversation state from snapshot if available.
    const conversationState = snapshot
      ? {
          messages: snapshot.state.conversationHistory.map((m) => ({
            id: m.id,
            role: this.mapRole(m.role),
            content: m.content,
            timestamp: m.timestamp,
          })),
          contextUsage: snapshot.state.contextUsage,
          lastActivityAt: Date.now(),
        }
      : { messages: [], contextUsage: { used: 0, total: 0 }, lastActivityAt: Date.now() };

    const checkpoint = this.errorRecovery.createCheckpoint(sessionId, type, {
      conversationState,
      activeTasks: snapshot
        ? snapshot.state.pendingTasks.map((t) => ({
            id: t.id,
            type: t.type,
            status: 'pending' as const,
            description: t.description,
          }))
        : [],
      metadata: {
        snapshotId: snapshot?.id ?? '',
        description,
      },
    });

    this.emit('checkpoint:created', { sessionId, checkpoint, snapshot });
    return checkpoint;
  }

  /**
   * Get available checkpoints for a session
   */
  getCheckpoints(sessionId: string): {
    recoveryCheckpoints: SessionCheckpoint[];
    snapshots: SessionSnapshot[];
  } {
    return {
      recoveryCheckpoints: this.errorRecovery.getCheckpoints(sessionId),
      snapshots: this.continuity.listSnapshots(sessionId),
    };
  }

  /**
   * Restore from a checkpoint
   */
  async restoreFromCheckpoint(
    checkpointId: string,
    sessionId: string
  ): Promise<{
    success: boolean;
    restoredState?: unknown;
    error?: string;
  }> {
    try {
      // Try error recovery checkpoint first
      const recoveryCheckpoint = this.errorRecovery.restoreCheckpoint(checkpointId);
      if (recoveryCheckpoint) {
        // Find corresponding snapshot
        const snapshotId = (recoveryCheckpoint.metadata?.['snapshotId'] as string) || '';
        if (snapshotId) {
          const state = await this.continuity.resumeSession(sessionId, {
            fromSnapshot: snapshotId,
            restoreMessages: true,
            restoreContext: true,
            restoreTasks: true,
          });

          if (state) {
            this.emit('checkpoint:restored', { checkpointId, sessionId, state });
            return { success: true, restoredState: state };
          }
        }

        return {
          success: true,
          restoredState: recoveryCheckpoint.conversationState,
        };
      }

      // Try session continuity snapshot
      const state = await this.continuity.resumeSession(sessionId, {
        fromSnapshot: checkpointId,
        restoreMessages: true,
        restoreContext: true,
        restoreTasks: true,
      });

      if (state) {
        this.emit('checkpoint:restored', { checkpointId, sessionId, state });
        return { success: true, restoredState: state };
      }

      return { success: false, error: 'Checkpoint not found' };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Generate recovery wizard steps based on available checkpoints
   */
  generateRecoveryWizard(sessionId: string): RecoveryWizardStep[] {
    const { recoveryCheckpoints, snapshots } = this.getCheckpoints(sessionId);
    const steps: RecoveryWizardStep[] = [];

    // Step 1: Introduction
    steps.push({
      type: 'info',
      title: 'Session Recovery',
      description: `We detected an issue with your session. You have ${recoveryCheckpoints.length + snapshots.length} recovery points available.`,
    });

    // Step 2: Choose checkpoint
    if (recoveryCheckpoints.length > 0 || snapshots.length > 0) {
      const options: RecoveryWizardStep['options'] = [];

      // Add most recent recovery checkpoints
      for (const cp of recoveryCheckpoints.slice(0, 3)) {
        options.push({
          id: cp.id,
          label: `Recovery: ${new Date(cp.createdAt).toLocaleString()}`,
          description: `${cp.type} checkpoint with ${cp.conversationState.messages.length} messages`,
          recommended: options.length === 0,
        });
      }

      // Add most recent snapshots
      for (const snap of snapshots.slice(0, 3)) {
        options.push({
          id: snap.id,
          label: snap.name || `Snapshot: ${new Date(snap.timestamp).toLocaleString()}`,
          description: `${snap.metadata.messageCount} messages, ${snap.metadata.tokensUsed} tokens`,
        });
      }

      steps.push({
        type: 'choice',
        title: 'Choose Recovery Point',
        description: 'Select a point to restore your session from:',
        options,
      });
    }

    // Step 3: Confirmation
    steps.push({
      type: 'confirm',
      title: 'Confirm Recovery',
      description: 'Are you sure you want to restore from the selected checkpoint? Any unsaved work since that point will be lost.',
    });

    return steps;
  }

  /**
   * Execute recovery based on wizard result
   */
  async executeRecovery(
    sessionId: string,
    result: RecoveryWizardResult
  ): Promise<{
    success: boolean;
    restoredState?: unknown;
    error?: string;
  }> {
    switch (result.action) {
      case 'restore':
        if (result.checkpointId) {
          return this.restoreFromCheckpoint(result.checkpointId, sessionId);
        }
        return { success: false, error: 'No checkpoint selected' };

      case 'partial_restore':
        // Implement partial restore logic
        if (result.checkpointId && result.selectedOptions) {
          const state = await this.continuity.resumeSession(sessionId, {
            fromSnapshot: result.checkpointId,
            restoreMessages: result.selectedOptions.includes('messages'),
            restoreContext: result.selectedOptions.includes('context'),
            restoreTasks: result.selectedOptions.includes('tasks'),
            restoreEnvironment: result.selectedOptions.includes('environment'),
          });
          return { success: !!state, restoredState: state };
        }
        return { success: false, error: 'No options selected' };

      case 'discard':
        // Clear all checkpoints for the session
        this.errorRecovery.clearCheckpoints(sessionId);
        return { success: true };

      case 'cancel':
      default:
        return { success: true };
    }
  }

  /**
   * Get transaction log for a session
   */
  getTransactionLog(
    sessionId?: string,
    options?: {
      type?: TransactionType;
      since?: number;
      limit?: number;
      successOnly?: boolean;
    }
  ): TransactionLogEntry[] {
    let entries = this.transactionLog;

    if (sessionId) {
      entries = entries.filter((e) => e.sessionId === sessionId);
    }

    if (options?.type) {
      entries = entries.filter((e) => e.type === options.type);
    }

    if (options?.since) {
      entries = entries.filter((e) => e.timestamp >= options.since!);
    }

    if (options?.successOnly) {
      entries = entries.filter((e) => e.success);
    }

    if (options?.limit) {
      entries = entries.slice(-options.limit);
    }

    return entries;
  }

  /**
   * Get pending transactions
   */
  getPendingTransactions(): TransactionLogEntry[] {
    return Array.from(this.pendingTransactions.values());
  }

  /**
   * Add entry to transaction log
   */
  private addToLog(entry: TransactionLogEntry): void {
    this.transactionLog.push(entry);

    // Trim in-memory log
    if (this.transactionLog.length > this.config.maxLogEntriesInMemory) {
      this.persistLog();
      this.transactionLog = this.transactionLog.slice(-Math.floor(this.config.maxLogEntriesInMemory / 2));
    }
  }

  /**
   * Persist transaction log to disk
   */
  private persistLog(): void {
    if (!this.config.enableTransactionLog) return;

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(this.logDir, `transactions-${timestamp}.jsonl`);

      const lines = this.transactionLog.map((e) => JSON.stringify(e)).join('\n');
      fs.appendFileSync(logFile, lines + '\n');

      // Rotate if needed
      this.rotateLogFiles();
    } catch (error) {
      logger.error('Failed to persist transaction log', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Rotate log files when they get too large
   */
  private rotateLogFiles(): void {
    try {
      const files = fs.readdirSync(this.logDir)
        .filter((f) => f.startsWith('transactions-'))
        .sort();

      let totalSize = 0;
      for (const file of files) {
        const stat = fs.statSync(path.join(this.logDir, file));
        totalSize += stat.size;
      }

      // Remove oldest files if over limit
      while (totalSize > this.config.maxLogFileSize && files.length > 1) {
        const oldest = files.shift()!;
        const oldestPath = path.join(this.logDir, oldest);
        const stat = fs.statSync(oldestPath);
        fs.unlinkSync(oldestPath);
        totalSize -= stat.size;
      }
    } catch (error) {
      logger.error('Failed to rotate log files', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Ensure required directories exist
   */
  private ensureDirectories(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Setup listeners for error recovery events
   */
  private setupErrorRecoveryListeners(): void {
    this.errorRecovery.on('recovery_plan_created', (event) => {
      // Log recovery action
      const entry: TransactionLogEntry = {
        id: `tx-recovery-${Date.now()}`,
        timestamp: Date.now(),
        sessionId: 'system',
        type: TransactionType.RECOVERY_ACTION,
        action: 'recovery_plan_created',
        details: {
          planId: event.plan.id,
          errorCategory: event.plan.error.category,
          actions: event.plan.actions.map((a: RecoveryAction) => a.type),
        },
        success: true,
      };
      this.addToLog(entry);
    });
  }

  /**
   * Map conversation entry roles to ConversationMessage roles
   */
  private mapRole(
    role: 'user' | 'assistant' | 'system' | 'tool'
  ): 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result' {
    switch (role) {
      case 'user':
        return 'user';
      case 'assistant':
        return 'assistant';
      case 'system':
        return 'system';
      case 'tool':
        return 'tool_result'; // Map 'tool' to 'tool_result' as it contains output
      default:
        return 'user';
    }
  }

  /**
   * Shutdown and cleanup
   */
  shutdown(): void {
    // Persist any remaining log entries
    if (this.transactionLog.length > 0) {
      this.persistLog();
    }

    // Clear pending transactions
    for (const entry of this.pendingTransactions.values()) {
      entry.error = 'Shutdown with pending transaction';
      this.addToLog(entry);
    }
    this.pendingTransactions.clear();
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.shutdown();
    this.removeAllListeners();
    CheckpointManager.instance = null;
  }
}

export function getCheckpointManager(): CheckpointManager {
  return CheckpointManager.getInstance();
}

export default CheckpointManager;
