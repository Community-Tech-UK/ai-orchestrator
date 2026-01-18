/**
 * Activity Debouncer Service
 *
 * Debounces activity status updates to prevent UI flickering.
 * Based on OpenCode's 2.5s debounce pattern.
 *
 * Behavior:
 * - If 2.5s+ since last change → update immediately
 * - Otherwise, queue update for remaining delay
 * - Flush immediately on status='idle' (completion)
 */

import { Injectable, OnDestroy, signal } from '@angular/core';
import { LIMITS } from '../../../../shared/constants/limits';

interface DebouncedActivity {
  activity: string;
  tool?: string;
  lastUpdate: number;
  pendingTimeout: ReturnType<typeof setTimeout> | null;
}

@Injectable({ providedIn: 'root' })
export class ActivityDebouncerService implements OnDestroy {
  private instanceActivities = new Map<string, DebouncedActivity>();
  private debounceMs = LIMITS.STATUS_DEBOUNCE_MS;

  /**
   * Signal map of debounced activities per instance
   * Key: instanceId, Value: current activity string
   */
  private _activities = signal<Map<string, string>>(new Map());
  readonly activities = this._activities.asReadonly();

  ngOnDestroy(): void {
    // Clear all pending timeouts
    for (const [, state] of this.instanceActivities) {
      if (state.pendingTimeout) {
        clearTimeout(state.pendingTimeout);
      }
    }
    this.instanceActivities.clear();
  }

  /**
   * Update the activity for an instance with debouncing
   */
  setActivity(instanceId: string, activity: string, tool?: string): void {
    const now = Date.now();
    const current = this.instanceActivities.get(instanceId);

    // If same activity, do nothing
    if (current?.activity === activity && current?.tool === tool) {
      return;
    }

    // Clear any pending timeout
    if (current?.pendingTimeout) {
      clearTimeout(current.pendingTimeout);
    }

    // Check if enough time has passed since last update
    const timeSinceLastUpdate = current ? now - current.lastUpdate : Infinity;

    if (timeSinceLastUpdate >= this.debounceMs) {
      // Enough time has passed, update immediately
      this.applyActivity(instanceId, activity, tool, now);
    } else {
      // Queue update for remaining delay
      const remainingDelay = this.debounceMs - timeSinceLastUpdate;
      const timeout = setTimeout(() => {
        this.applyActivity(instanceId, activity, tool, Date.now());
      }, remainingDelay);

      // Store pending state
      this.instanceActivities.set(instanceId, {
        activity: current?.activity || '',
        tool: current?.tool,
        lastUpdate: current?.lastUpdate || now,
        pendingTimeout: timeout,
      });
    }
  }

  /**
   * Immediately flush any pending activity update
   * Call this when instance becomes idle to ensure final state is shown
   */
  flushActivity(instanceId: string, activity?: string): void {
    const current = this.instanceActivities.get(instanceId);

    // Clear pending timeout
    if (current?.pendingTimeout) {
      clearTimeout(current.pendingTimeout);
    }

    // Apply activity immediately
    const finalActivity = activity ?? '';
    this.applyActivity(instanceId, finalActivity, undefined, Date.now());
  }

  /**
   * Clear activity for an instance (when terminated or idle)
   */
  clearActivity(instanceId: string): void {
    const current = this.instanceActivities.get(instanceId);
    if (current?.pendingTimeout) {
      clearTimeout(current.pendingTimeout);
    }
    this.instanceActivities.delete(instanceId);

    // Update signal
    this._activities.update((map) => {
      const newMap = new Map(map);
      newMap.delete(instanceId);
      return newMap;
    });
  }

  /**
   * Get current debounced activity for an instance
   */
  getActivity(instanceId: string): string {
    return this._activities().get(instanceId) || '';
  }

  /**
   * Apply the activity update (internal)
   */
  private applyActivity(
    instanceId: string,
    activity: string,
    tool: string | undefined,
    timestamp: number
  ): void {
    this.instanceActivities.set(instanceId, {
      activity,
      tool,
      lastUpdate: timestamp,
      pendingTimeout: null,
    });

    // Update signal
    this._activities.update((map) => {
      const newMap = new Map(map);
      if (activity) {
        newMap.set(instanceId, activity);
      } else {
        newMap.delete(instanceId);
      }
      return newMap;
    });
  }
}
