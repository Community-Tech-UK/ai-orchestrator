// src/main/state/index.ts
import { createStore, type Store } from './store';
import { INITIAL_APP_STATE, type AppState } from './app-state';

let appStore: Store<AppState> | null = null;

export function getAppStore(): Store<AppState> {
  if (!appStore) appStore = createStore(INITIAL_APP_STATE);
  return appStore;
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
export type { AppState } from './app-state';
export { INITIAL_APP_STATE } from './app-state';
export type { Store } from './store';
export { createStore } from './store';
