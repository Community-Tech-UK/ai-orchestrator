/**
 * Update Batcher Service - Batches high-frequency updates to prevent UI thrashing
 */

import { Injectable } from '@angular/core';
import type { ExecutionLocation } from '../../../../shared/types/worker-node.types';
import type { ActivityState } from '../../../../shared/types/activity.types';

export interface StateUpdate {
  instanceId: string;
  status?: string;
  activityState?: ActivityState;
  contextUsage?: {
    used: number;
    total: number;
    percentage: number;
  };
  diffStats?: {
    totalAdded: number;
    totalDeleted: number;
    files: Record<string, { path: string; status: 'added' | 'modified' | 'deleted'; added: number; deleted: number }>;
  } | null;
  displayName?: string;
  /**
   * Resolved model identifier emitted from the main process after the
   * lifecycle's Phase 2 model resolution completes. The IPC response from
   * `INSTANCE_CREATE` returns at Phase 1 with `currentModel: undefined`,
   * so the renderer relies on this field to learn the resolved model
   * without polling. Optional because most state updates don't change it.
   */
  currentModel?: string;
  executionLocation?: ExecutionLocation;
  providerSessionId?: string;
  restartEpoch?: number;
  adapterGeneration?: number;
  activeTurnId?: string;
  interruptRequestId?: string;
  interruptRequestedAt?: number;
  interruptPhase?: 'requested' | 'accepted' | 'completed' | 'timed-out' | 'escalated';
  lastTurnOutcome?: 'completed' | 'interrupted' | 'cancelled' | 'failed';
  supersededBy?: string;
  cancelledForEdit?: boolean;
  recoveryMethod?: 'native' | 'replay' | 'fresh' | 'failed';
  archivedUpToMessageId?: string;
  historyThreadId?: string;
}

type FlushCallback = (updates: StateUpdate[]) => void;

@Injectable({ providedIn: 'root' })
export class UpdateBatcherService {
  private queue = new Map<string, StateUpdate>();
  private flushCallbacks: FlushCallback[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private readonly BATCH_INTERVAL = 50; // 50ms batching window

  constructor() {
    this.startBatching();
  }

  /**
   * Queue a single update
   */
  queueUpdate(update: StateUpdate): void {
    // Later updates for same instance override earlier ones
    const existing = this.queue.get(update.instanceId);
    this.queue.set(update.instanceId, {
      ...existing,
      ...update,
      // Preserve diffStats only when the new update doesn't carry them at all.
      diffStats: update.diffStats !== undefined ? update.diffStats : existing?.diffStats,
      // Preserve displayName if the new update doesn't carry it
      displayName: update.displayName ?? existing?.displayName,
      // Preserve executionLocation if the new update doesn't carry it
      executionLocation: update.executionLocation ?? existing?.executionLocation,
      activityState: update.activityState ?? existing?.activityState,
      // Preserve currentModel if the new update doesn't carry it. Phase 2 of
      // createInstance emits a single update with this field; intervening
      // status-only updates must not wipe it out.
      currentModel: update.currentModel ?? existing?.currentModel,
      providerSessionId: update.providerSessionId ?? existing?.providerSessionId,
      restartEpoch: update.restartEpoch ?? existing?.restartEpoch,
      recoveryMethod: update.recoveryMethod ?? existing?.recoveryMethod,
      archivedUpToMessageId:
        update.archivedUpToMessageId ?? existing?.archivedUpToMessageId,
      historyThreadId: update.historyThreadId ?? existing?.historyThreadId,
    });
  }

  /**
   * Queue multiple updates
   */
  queueUpdates(updates: StateUpdate[]): void {
    for (const update of updates) {
      this.queueUpdate(update);
    }
  }

  /**
   * Register a callback for when updates are flushed
   */
  onFlush(callback: FlushCallback): () => void {
    this.flushCallbacks.push(callback);
    return () => {
      const index = this.flushCallbacks.indexOf(callback);
      if (index > -1) {
        this.flushCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Start the batching interval
   */
  private startBatching(): void {
    this.flushInterval = setInterval(() => {
      this.flush();
    }, this.BATCH_INTERVAL);
  }

  /**
   * Flush all queued updates
   */
  private flush(): void {
    if (this.queue.size === 0) return;

    const updates = Array.from(this.queue.values());
    this.queue.clear();

    for (const callback of this.flushCallbacks) {
      try {
        callback(updates);
      } catch (error) {
        console.error('Error in flush callback:', error);
      }
    }
  }

  /**
   * Force flush immediately
   */
  forceFlush(): void {
    this.flush();
  }

  /**
   * Get pending update count
   */
  get pendingCount(): number {
    return this.queue.size;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this.flushInterval !== null) {
      clearInterval(this.flushInterval);
    }
    this.queue.clear();
    this.flushCallbacks = [];
  }
}
