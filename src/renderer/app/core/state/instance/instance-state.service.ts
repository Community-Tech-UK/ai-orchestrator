/**
 * Instance State Service - Shared state holder for instance sub-stores
 *
 * This service holds the single source of truth for instance state.
 * All sub-stores inject this service to read/update state.
 */

import { Injectable, signal } from '@angular/core';
import { readStorage, writeStorage, type StorageField } from '../../../shared/utils/typed-storage';
import { getInstanceThreadId } from './instance.types';
import type {
  InstanceStoreState,
  Instance,
  OutputMessage,
  QueuedMessage,
} from './instance.types';

/**
 * Unread-completion markers are keyed by `historyThreadId`, not by instance id.
 * An instance id is minted per spawn and is replaced whenever a thread is
 * restored, so keying by it stranded every marker across an app restart — the
 * id simply stopped matching anything the rail could render. `historyThreadId`
 * is the stable app-level thread identity that survives restore and fallback,
 * which is exactly what a "you have not viewed this yet" marker needs.
 */
const UNREAD_COMPLETIONS_FIELD: StorageField<string[]> = {
  key: 'instance-unread-completions',
  version: 2,
  defaultValue: [],
  validate: (value): value is string[] =>
    Array.isArray(value) && value.every((id) => typeof id === 'string'),
};

@Injectable({ providedIn: 'root' })
export class InstanceStateService {
  private readonly unreadThreadIds = new Set<string>(readStorage(UNREAD_COMPLETIONS_FIELD));

  // ============================================
  // Main State Signal
  // ============================================

  readonly state = signal<InstanceStoreState>({
    instances: new Map(),
    selectedInstanceId: null,
    loading: false,
    error: null,
  });

  // ============================================
  // Output Throttling State (private to output store)
  // ============================================

  readonly outputThrottleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly pendingOutputMessages = new Map<string, OutputMessage[]>();
  /**
   * Instances holding history the user loaded from disk (scroll-up, scroll to
   * top, jump rail). The buffer cap must not trim it while they read it — see
   * InstanceOutputStore.releaseLoadedHistory.
   */
  readonly loadedHistoryInstances = new Set<string>();

  // ============================================
  // Message Queue State (reactive signal)
  // ============================================

  readonly messageQueue = signal(new Map<string, QueuedMessage[]>());

  // ============================================
  // State Update Helpers
  // ============================================

  /**
   * Update the loading state
   */
  setLoading(loading: boolean): void {
    this.state.update((s) => (s.loading === loading ? s : { ...s, loading }));
  }

  /**
   * Set an error message
   */
  setError(error: string | null): void {
    this.state.update((s) => (s.error === error ? s : { ...s, error }));
  }

  /**
   * Update a specific instance.
   *
   * No-op guard: status/activity updates fire at high frequency and most carry
   * values that are already current (e.g. re-broadcasting `status: 'active'`).
   * Returning the *same* state reference when nothing actually changes means
   * Angular's `Object.is` signal equality skips notifying every `instances`-
   * derived computed — the core discipline behind backlog #25. Fields are
   * compared with `Object.is`; object-valued fields compare by reference, which
   * is conservative (a fresh reference counts as a change, never a false skip).
   */
  updateInstance(instanceId: string, updates: Partial<Instance>): void {
    const existing = this.state().instances.get(instanceId);
    this.state.update((current) => {
      const instance = current.instances.get(instanceId);
      if (!instance) {
        return current; // unknown instance — nothing to merge
      }
      let changed = false;
      for (const key of Object.keys(updates) as (keyof Instance)[]) {
        if (!Object.is(instance[key], updates[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        return current; // every updated field already current — skip the write
      }
      const newMap = new Map(current.instances);
      newMap.set(instanceId, { ...instance, ...updates });
      return { ...current, instances: newMap };
    });
    if (existing && typeof updates.hasUnreadCompletion === 'boolean') {
      this.setUnreadThread(
        getInstanceThreadId({ ...existing, ...updates }),
        updates.hasUnreadCompletion,
      );
    }
  }

  /**
   * True when this thread finished work that has not been viewed yet.
   *
   * Keyed by thread id so the marker survives a restart and any restore that
   * mints a fresh instance id. Read by both the live row and the history row.
   */
  isThreadUnread(threadId: string): boolean {
    return this.unreadThreadIds.has(threadId);
  }

  /**
   * Clear the unviewed-completion marker for a thread. Called when the user
   * actually opens the thread — the only thing the marker is meant to wait for.
   */
  clearThreadUnread(threadId: string): void {
    this.setUnreadThread(threadId, false);
  }

  private setUnreadThread(threadId: string, unread: boolean): void {
    if (!threadId) return;
    if (this.unreadThreadIds.has(threadId) === unread) return;
    if (unread) {
      this.unreadThreadIds.add(threadId);
    } else {
      this.unreadThreadIds.delete(threadId);
    }
    writeStorage(UNREAD_COMPLETIONS_FIELD, [...this.unreadThreadIds]);
  }

  /**
   * Add an instance to the store.
   *
   * Never changes the selection — callers that want the new instance focused
   * (explicit create/restore/fork flows) must call setSelectedInstance
   * themselves. Background-created sessions must not steal focus.
   */
  addInstance(instance: Instance): void {
    this.state.update((current) => {
      const newMap = new Map(current.instances);
      newMap.set(instance.id, {
        ...instance,
        hasUnreadCompletion:
          instance.hasUnreadCompletion || this.isThreadUnread(getInstanceThreadId(instance)),
      });
      return {
        ...current,
        instances: newMap,
        loading: false,
      };
    });
  }

  /**
   * Remove an instance from the store.
   *
   * Deliberately does NOT clear the thread's unviewed-completion marker. The
   * marker means "you have not viewed this thread's output yet", and an
   * instance leaving the live map is not a view. On shutdown every instance is
   * removed, so clearing here is exactly what erased every marker across a
   * restart — the thread survives as history and the marker must survive with it.
   */
  removeInstance(instanceId: string): void {
    this.state.update((current) => {
      const newMap = new Map(current.instances);
      newMap.delete(instanceId);
      return {
        ...current,
        instances: newMap,
        selectedInstanceId:
          current.selectedInstanceId === instanceId ? null : current.selectedInstanceId,
      };
    });
  }

  /**
   * Set the selected instance
   */
  setSelectedInstance(id: string | null): void {
    this.state.update((s) => (s.selectedInstanceId === id ? s : { ...s, selectedInstanceId: id }));
  }

  /**
   * Get an instance by ID
   */
  getInstance(id: string): Instance | undefined {
    return this.state().instances.get(id);
  }

  /**
   * Set all instances (for initial load)
   */
  setInstances(instances: Map<string, Instance>): void {
    const restored = new Map<string, Instance>();
    for (const [id, instance] of instances) {
      restored.set(id, {
        ...instance,
        hasUnreadCompletion:
          instance.hasUnreadCompletion || this.isThreadUnread(getInstanceThreadId(instance)),
      });
    }
    this.state.update((s) => ({
      ...s,
      instances: restored,
      loading: false,
    }));
  }
}
