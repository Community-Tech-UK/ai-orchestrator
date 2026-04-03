// src/main/state/observers.ts
import type { Store } from './store';
import type { AppState, InstanceSlice } from './app-state';

/**
 * Watch for changes to a specific field on a specific instance.
 * The callback fires only when the field value changes (strict equality).
 */
export function observeInstanceField<K extends keyof InstanceSlice>(
  store: Store<AppState>,
  instanceId: string,
  field: K,
  callback: (newVal: InstanceSlice[K], oldVal: InstanceSlice[K]) => void,
): () => void {
  return store.subscribe((next, prev) => {
    const nextInst = next.instances[instanceId];
    const prevInst = prev.instances[instanceId];
    if (!nextInst || !prevInst) return;
    if (nextInst[field] !== prevInst[field]) {
      callback(nextInst[field], prevInst[field]);
    }
  });
}

/**
 * Watch for instance additions and removals in the store.
 * `onAdded` fires with the full InstanceSlice when a new key appears.
 * `onRemoved` fires with the instance id when a key disappears.
 */
export function observeInstances(
  store: Store<AppState>,
  callbacks: {
    onAdded?: (instance: InstanceSlice) => void;
    onRemoved?: (id: string) => void;
  },
): () => void {
  return store.subscribe((next, prev) => {
    if (callbacks.onAdded) {
      for (const id of Object.keys(next.instances)) {
        if (!prev.instances[id]) {
          callbacks.onAdded(next.instances[id]!);
        }
      }
    }
    if (callbacks.onRemoved) {
      for (const id of Object.keys(prev.instances)) {
        if (!next.instances[id]) {
          callbacks.onRemoved(id);
        }
      }
    }
  });
}

/**
 * Watch for changes to a top-level field in AppState.global.
 * The callback fires only when the field value changes (strict equality).
 */
export function observeGlobal<K extends keyof AppState['global']>(
  store: Store<AppState>,
  field: K,
  callback: (newVal: AppState['global'][K]) => void,
): () => void {
  return store.subscribe((next, prev) => {
    if (next.global[field] !== prev.global[field]) {
      callback(next.global[field]);
    }
  });
}
