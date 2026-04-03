// src/main/state/store.ts

export interface Store<T> {
  getState(): Readonly<T>;
  setState(updater: (prev: Readonly<T>) => T): void;
  subscribe(listener: (state: Readonly<T>, prev: Readonly<T>) => void): () => void;
}

export function createStore<T>(initialState: T): Store<T> {
  let state = initialState;
  let updating = false;
  // Use an array of wrapper objects so the same function can be subscribed multiple times.
  const listeners: { fn: (state: Readonly<T>, prev: Readonly<T>) => void }[] = [];

  return {
    getState: () => state,
    setState: (updater) => {
      if (updating) throw new Error('Re-entrant setState detected');
      updating = true;
      try {
        const prev = state;
        const next = updater(prev);
        if (next === prev) return;
        state = next;
        // Snapshot the listeners array so mid-notification mutations are safe.
        for (const entry of [...listeners]) {
          entry.fn(state, prev);
        }
      } finally {
        updating = false;
      }
    },
    subscribe: (listener) => {
      const entry = { fn: listener };
      listeners.push(entry);
      return () => {
        const idx = listeners.indexOf(entry);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    },
  };
}
