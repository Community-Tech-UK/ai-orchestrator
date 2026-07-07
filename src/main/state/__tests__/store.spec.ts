// src/main/state/__tests__/store.spec.ts
import { describe, it, expect } from 'vitest';
import { createStore } from '../store';

describe('createStore', () => {
  describe('getState', () => {
    it('returns the initial state', () => {
      const store = createStore({ count: 0 });
      expect(store.getState()).toEqual({ count: 0 });
    });

    it('returns a readonly reference — same object until mutated', () => {
      const initial = { count: 0 };
      const store = createStore(initial);
      expect(store.getState()).toBe(initial);
    });
  });

  describe('setState', () => {
    it('updates state via updater function', () => {
      const store = createStore({ count: 0 });
      store.setState((prev) => ({ ...prev, count: prev.count + 1 }));
      expect(store.getState().count).toBe(1);
    });

    it('keeps the same state reference when next === prev', () => {
      const store = createStore({ count: 0 });
      const initial = store.getState();
      store.setState((prev) => prev);
      expect(store.getState()).toBe(initial);
    });
  });

  describe('state immutability contract', () => {
    it('getState always returns the latest state after multiple setStates', () => {
      const store = createStore({ count: 0 });
      store.setState((prev) => ({ ...prev, count: 1 }));
      store.setState((prev) => ({ ...prev, count: 2 }));
      store.setState((prev) => ({ ...prev, count: 3 }));
      expect(store.getState().count).toBe(3);
    });
  });
});
