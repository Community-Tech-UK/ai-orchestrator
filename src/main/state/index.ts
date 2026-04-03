// src/main/state/index.ts
import { createStore, type Store } from './store';
import { INITIAL_APP_STATE, type AppState, type InstanceSlice } from './app-state';

let appStore: Store<AppState> | null = null;

export function getAppStore(): Store<AppState> {
  if (!appStore) appStore = createStore(INITIAL_APP_STATE);
  return appStore;
}

// ── Convenience mutators ────────────────────────────────────────────────────

export function addInstance(slice: InstanceSlice): void {
  getAppStore().setState((prev) => ({
    ...prev,
    instances: { ...prev.instances, [slice.id]: slice },
  }));
}

export function removeInstance(id: string): void {
  getAppStore().setState((prev) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { [id]: _removed, ...rest } = prev.instances;
    return { ...prev, instances: rest };
  });
}

export function updateInstance(id: string, updates: Partial<InstanceSlice>): void {
  getAppStore().setState((prev) => {
    const existing = prev.instances[id];
    if (!existing) return prev; // No-op — instance not tracked
    return {
      ...prev,
      instances: { ...prev.instances, [id]: { ...existing, ...updates } },
    };
  });
}

export function setGlobalState(updates: Partial<AppState['global']>): void {
  getAppStore().setState((prev) => ({
    ...prev,
    global: { ...prev.global, ...updates },
  }));
}

// ── Testing support ─────────────────────────────────────────────────────────

export function _resetStoreForTesting(): void {
  appStore = null;
}

// Re-export everything callers need from a single import path
export type { AppState, InstanceSlice } from './app-state';
export { INITIAL_APP_STATE } from './app-state';
export type { Store } from './store';
export { createStore } from './store';
export {
  selectInstance,
  selectAllInstances,
  selectByStatus,
  selectCanCreate,
  selectInstanceCount,
  selectTotalTokens,
} from './selectors';
export {
  observeInstanceField,
  observeInstances,
  observeGlobal,
} from './observers';
