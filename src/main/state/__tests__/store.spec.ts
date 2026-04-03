// src/main/state/__tests__/store.spec.ts
import { describe, it, expect, vi } from 'vitest';
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

    it('does not notify listeners when next === prev (same reference)', () => {
      const store = createStore({ count: 0 });
      const listener = vi.fn();
      store.subscribe(listener);
      store.setState((prev) => prev); // same reference
      expect(listener).not.toHaveBeenCalled();
    });

    it('notifies listeners with next and prev state', () => {
      const store = createStore({ count: 0 });
      const listener = vi.fn();
      store.subscribe(listener);
      store.setState((prev) => ({ ...prev, count: 1 }));
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith({ count: 1 }, { count: 0 });
    });

    it('notifies all listeners on each setState', () => {
      const store = createStore({ count: 0 });
      const a = vi.fn();
      const b = vi.fn();
      store.subscribe(a);
      store.subscribe(b);
      store.setState((prev) => ({ ...prev, count: 1 }));
      expect(a).toHaveBeenCalledOnce();
      expect(b).toHaveBeenCalledOnce();
    });

    it('throws on re-entrant setState', () => {
      const store = createStore({ count: 0 });
      store.subscribe(() => {
        // Re-entrant call from within a listener
        expect(() => store.setState((prev) => ({ ...prev, count: 99 }))).toThrow(
          'Re-entrant setState detected',
        );
      });
      store.setState((prev) => ({ ...prev, count: 1 }));
    });
  });

  describe('subscribe', () => {
    it('returns an unsubscribe function', () => {
      const store = createStore({ count: 0 });
      const listener = vi.fn();
      const unsub = store.subscribe(listener);
      unsub();
      store.setState((prev) => ({ ...prev, count: 1 }));
      expect(listener).not.toHaveBeenCalled();
    });

    it('unsubscribing mid-notification does not affect other listeners', () => {
      const store = createStore({ count: 0 });
      const b = vi.fn();
      const holder: { unsub: (() => void) | undefined } = { unsub: undefined };
      holder.unsub = store.subscribe(() => holder.unsub?.()); // self-unsubscribes
      store.subscribe(b);
      store.setState((prev) => ({ ...prev, count: 1 }));
      expect(b).toHaveBeenCalledOnce();
    });

    it('multiple subscriptions to the same function each get their own token', () => {
      const store = createStore({ count: 0 });
      const listener = vi.fn();
      const unsub1 = store.subscribe(listener);
      const unsub2 = store.subscribe(listener);
      store.setState((prev) => ({ ...prev, count: 1 }));
      expect(listener).toHaveBeenCalledTimes(2); // both subscriptions fire
      unsub1();
      unsub2();
      store.setState((prev) => ({ ...prev, count: 2 }));
      expect(listener).toHaveBeenCalledTimes(2); // neither fires after unsub
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
