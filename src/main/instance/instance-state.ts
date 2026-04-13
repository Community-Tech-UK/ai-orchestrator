/**
 * Instance State Manager - Manages instance state, adapters, and batch updates
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { SessionDiffTracker } from './session-diff-tracker';
import { InstanceStateMachine } from './instance-state-machine';
import type {
  Instance,
  InstanceStatus,
  ContextUsage,
  SessionDiffStats
} from '../../shared/types/instance.types';
import type {
  InstanceStateUpdatePayload,
  BatchUpdatePayload,
  ErrorInfo
} from '../../shared/types/ipc.types';
import type { ExecutionLocation } from '../../shared/types/worker-node.types';
import { LIMITS } from '../../shared/constants/limits';

const logger = getLogger('InstanceState');

export class InstanceStateManager extends EventEmitter {
  private instances: Map<string, Instance> = new Map();
  private adapters: Map<string, CliAdapter> = new Map();
  private diffTrackers = new Map<string, SessionDiffTracker>();
  private stateMachines = new Map<string, InstanceStateMachine>();
  private pendingUpdates: Map<string, InstanceStateUpdatePayload> = new Map();
  private batchTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startBatchTimer();
  }

  // ============================================
  // Instance Accessors
  // ============================================

  /**
   * Get an instance by ID
   */
  getInstance(id: string): Instance | undefined {
    return this.instances.get(id);
  }

  /**
   * Check if an instance exists
   */
  hasInstance(id: string): boolean {
    return this.instances.has(id);
  }

  /**
   * Get all instances
   */
  getAllInstances(): Instance[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get all instances serialized for IPC
   */
  getAllInstancesForIpc(): Record<string, unknown>[] {
    return this.getAllInstances().map((i) => this.serializeForIpc(i));
  }

  /**
   * Get the number of instances
   */
  getInstanceCount(): number {
    return this.instances.size;
  }

  /**
   * Store an instance
   */
  setInstance(instance: Instance): void {
    this.instances.set(instance.id, instance);
  }

  /**
   * Remove an instance
   */
  deleteInstance(id: string): boolean {
    return this.instances.delete(id);
  }

  /**
   * Iterate over all instances
   */
  forEachInstance(callback: (instance: Instance, id: string) => void): void {
    this.instances.forEach(callback);
  }

  // ============================================
  // Adapter Accessors
  // ============================================

  /**
   * Get an adapter by instance ID
   */
  getAdapter(instanceId: string): CliAdapter | undefined {
    return this.adapters.get(instanceId);
  }

  /**
   * Check if an adapter exists
   */
  hasAdapter(instanceId: string): boolean {
    return this.adapters.has(instanceId);
  }

  /**
   * Store an adapter
   */
  setAdapter(instanceId: string, adapter: CliAdapter): void {
    logger.debug('setAdapter called', { instanceId });
    this.adapters.set(instanceId, adapter);
    logger.debug('Adapter stored', { instanceId, adapterCount: this.adapters.size });
  }

  /**
   * Remove an adapter
   */
  deleteAdapter(instanceId: string): boolean {
    logger.debug('deleteAdapter called', { instanceId });
    return this.adapters.delete(instanceId);
  }

  /**
   * Get all adapter entries for iteration
   */
  getAdapterEntries(): IterableIterator<[string, CliAdapter]> {
    return this.adapters.entries();
  }

  // ============================================
  // Diff Tracker Accessors
  // ============================================

  /**
   * Get the SessionDiffTracker for an instance
   */
  getDiffTracker(instanceId: string): SessionDiffTracker | undefined {
    return this.diffTrackers.get(instanceId);
  }

  /**
   * Store a SessionDiffTracker for an instance
   */
  setDiffTracker(instanceId: string, tracker: SessionDiffTracker): void {
    this.diffTrackers.set(instanceId, tracker);
  }

  /**
   * Remove the SessionDiffTracker for an instance
   */
  deleteDiffTracker(instanceId: string): void {
    this.diffTrackers.delete(instanceId);
  }

  // ============================================
  // State Machine Accessors
  // ============================================

  /**
   * Get the InstanceStateMachine for an instance
   */
  getStateMachine(instanceId: string): InstanceStateMachine | undefined {
    return this.stateMachines.get(instanceId);
  }

  /**
   * Create and store an InstanceStateMachine for an instance
   */
  setStateMachine(instanceId: string, machine: InstanceStateMachine): void {
    this.stateMachines.set(instanceId, machine);
  }

  /**
   * Remove the InstanceStateMachine for an instance
   */
  deleteStateMachine(instanceId: string): void {
    this.stateMachines.delete(instanceId);
  }

  // ============================================
  // Batch Update System
  // ============================================

  /**
   * Queue a state update for batching
   */
  queueUpdate(
    instanceId: string,
    status: InstanceStatus,
    contextUsage?: ContextUsage,
    diffStats?: SessionDiffStats | null,
    displayName?: string,
    error?: ErrorInfo,
    executionLocation?: ExecutionLocation,
    sessionState?: {
      providerSessionId?: string;
      restartEpoch?: number;
      recoveryMethod?: Instance['recoveryMethod'];
      archivedUpToMessageId?: string;
      historyThreadId?: string;
    }
  ): void {
    const existing = this.pendingUpdates.get(instanceId);
    this.pendingUpdates.set(instanceId, {
      instanceId,
      status,
      contextUsage: contextUsage ?? existing?.contextUsage,
      diffStats: diffStats !== undefined ? diffStats : existing?.diffStats,
      displayName: displayName ?? existing?.displayName,
      error: error ?? existing?.error,
      executionLocation: executionLocation ?? existing?.executionLocation,
      providerSessionId: sessionState?.providerSessionId ?? existing?.providerSessionId,
      restartEpoch: sessionState?.restartEpoch ?? existing?.restartEpoch,
      recoveryMethod: sessionState?.recoveryMethod ?? existing?.recoveryMethod,
      archivedUpToMessageId:
        sessionState?.archivedUpToMessageId ?? existing?.archivedUpToMessageId,
      historyThreadId: sessionState?.historyThreadId ?? existing?.historyThreadId,
    });
  }

  /**
   * Start the batch update timer
   */
  private startBatchTimer(): void {
    this.batchTimer = setInterval(() => {
      this.flushUpdates();
    }, LIMITS.OUTPUT_BATCH_INTERVAL_MS);
  }

  /**
   * Flush pending updates to renderer
   */
  private flushUpdates(): void {
    if (this.pendingUpdates.size === 0) return;

    const updates = Array.from(this.pendingUpdates.values());
    this.pendingUpdates.clear();

    const batchPayload: BatchUpdatePayload = {
      updates,
      timestamp: Date.now()
    };

    this.emit('batch-update', batchPayload);
  }

  // ============================================
  // Serialization
  // ============================================

  /**
   * Serialize instance for IPC (convert Maps to Objects).
   *
   * Strips non-cloneable properties (Promises, AbortController) that would
   * cause V8 structured-clone to throw a DataCloneError when sent via
   * webContents.send() or ipcMain.handle().
   */
  serializeForIpc(instance: Instance): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { readyPromise, respawnPromise, abortController, communicationTokens, ...rest } = instance;
    return {
      ...rest,
      communicationTokens: Object.fromEntries(communicationTokens)
    };
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Stop batch timer on shutdown
   */
  destroy(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    // Flush any remaining updates
    this.flushUpdates();
    this.stateMachines.clear();
  }
}
