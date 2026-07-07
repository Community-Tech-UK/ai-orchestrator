// src/main/state/store.ts

export interface Store<T> {
  getState(): Readonly<T>;
  setState(updater: (prev: Readonly<T>) => T): void;
}

export function createStore<T>(initialState: T): Store<T> {
  let state = initialState;

  return {
    getState: () => state,
    setState: (updater) => {
      const next = updater(state);
      if (next !== state) {
        state = next;
      }
    },
  };
}
