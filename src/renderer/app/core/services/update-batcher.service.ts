/**
 * Update Batcher Service - Batches high-frequency updates to prevent UI thrashing
 */

import { Injectable } from '@angular/core';

export interface StateUpdate {
  instanceId: string;
  status?: string;
  contextUsage?: {
    used: number;
    total: number;
    percentage: number;
  };
  diffStats?: {
    totalAdded: number;
    totalDeleted: number;
    files: Record<string, { path: string; status: 'added' | 'modified' | 'deleted'; added: number; deleted: number }>;
  };
  displayName?: string;
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
      // Preserve diffStats if the new update doesn't carry them
      diffStats: update.diffStats ?? existing?.diffStats,
      // Preserve displayName if the new update doesn't carry it
      displayName: update.displayName ?? existing?.displayName,
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
