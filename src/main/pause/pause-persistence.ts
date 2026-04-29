import ElectronStore from 'electron-store';
import type { PauseReason } from '@contracts/schemas/pause';

export type { PauseReason };

export interface PauseTransition {
  at: number;
  from: readonly PauseReason[];
  to: readonly PauseReason[];
  trigger: string;
}

export interface PersistedPauseState {
  reasons: PauseReason[];
  persistedAt: number;
  recentTransitions: PauseTransition[];
}

const MAX_TRANSITIONS = 20;

interface Store<T> {
  store: T;
  set<K extends keyof T>(key: K, value: T[K]): void;
  clear(): void;
}

interface BackingShape {
  state?: PersistedPauseState;
}

function isValidReason(value: unknown): value is PauseReason {
  return value === 'vpn' || value === 'user' || value === 'detector-error';
}

function isValidTransition(value: unknown): value is PauseTransition {
  if (!value || typeof value !== 'object') return false;
  const transition = value as Partial<PauseTransition>;
  return (
    typeof transition.at === 'number' &&
    Array.isArray(transition.from) &&
    transition.from.every(isValidReason) &&
    Array.isArray(transition.to) &&
    transition.to.every(isValidReason) &&
    typeof transition.trigger === 'string'
  );
}

function isValidState(value: unknown): value is PersistedPauseState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<PersistedPauseState>;
  return (
    Array.isArray(state.reasons) &&
    state.reasons.every(isValidReason) &&
    typeof state.persistedAt === 'number' &&
    Array.isArray(state.recentTransitions) &&
    state.recentTransitions.every(isValidTransition)
  );
}

export class PausePersistence {
  private store: Store<BackingShape>;

  constructor() {
    this.store = new ElectronStore<BackingShape>({ name: 'pause-state' }) as unknown as Store<BackingShape>;
  }

  load(): PersistedPauseState | null | 'corrupted' {
    const raw = this.store.store?.state;
    if (raw === undefined || raw === null) return null;
    return isValidState(raw) ? raw : 'corrupted';
  }

  save(state: PersistedPauseState): void {
    this.store.set('state', {
      ...state,
      recentTransitions: state.recentTransitions.slice(-MAX_TRANSITIONS),
    });
  }

  clear(): void {
    this.store.clear();
  }
}
