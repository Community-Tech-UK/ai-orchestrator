// src/main/state/__tests__/observers.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStore } from '../store';
import { INITIAL_APP_STATE, type AppState, type InstanceSlice } from '../app-state';
import {
  observeInstanceField,
  observeInstances,
  observeGlobal,
} from '../observers';

function makeSlice(id: string, overrides: Partial<InstanceSlice> = {}): InstanceSlice {
  return {
    id,
    displayName: 'Test',
    status: 'idle',
    contextUsage: { used: 0, total: 200_000, percentage: 0 },
    lastActivity: 0,
    provider: 'claude',
    parentId: null,
    childrenIds: [],
    agentId: 'build',
    workingDirectory: '/tmp',
    processId: null,
    errorCount: 0,
    totalTokensUsed: 0,
    ...overrides,
  };
}

describe('observers', () => {
  let store: ReturnType<typeof createStore<AppState>>;

  beforeEach(() => {
    store = createStore<AppState>(INITIAL_APP_STATE);
  });

  describe('observeInstanceField', () => {
    it('calls callback when the specified field changes', () => {
      const slice = makeSlice('inst-1', { status: 'idle' });
      store.setState((prev) => ({
        ...prev,
        instances: { 'inst-1': slice },
      }));

      const cb = vi.fn();
      observeInstanceField(store, 'inst-1', 'status', cb);

      store.setState((prev) => ({
        ...prev,
        instances: {
          'inst-1': { ...prev.instances['inst-1']!, status: 'busy' },
        },
      }));

      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith('busy', 'idle');
    });

    it('does not call callback when a different field changes', () => {
      const slice = makeSlice('inst-1');
      store.setState((prev) => ({
        ...prev,
        instances: { 'inst-1': slice },
      }));

      const cb = vi.fn();
      observeInstanceField(store, 'inst-1', 'status', cb);

      store.setState((prev) => ({
        ...prev,
        instances: {
          'inst-1': { ...prev.instances['inst-1']!, errorCount: 5 },
        },
      }));

      expect(cb).not.toHaveBeenCalled();
    });

    it('does not call callback when the instance does not exist', () => {
      const cb = vi.fn();
      observeInstanceField(store, 'nonexistent', 'status', cb);

      store.setState((prev) => ({
        ...prev,
        instances: { 'other': makeSlice('other') },
      }));

      expect(cb).not.toHaveBeenCalled();
    });

    it('returns an unsubscribe function that stops future calls', () => {
      const slice = makeSlice('inst-1');
      store.setState((prev) => ({
        ...prev,
        instances: { 'inst-1': slice },
      }));

      const cb = vi.fn();
      const unsub = observeInstanceField(store, 'inst-1', 'status', cb);
      unsub();

      store.setState((prev) => ({
        ...prev,
        instances: {
          'inst-1': { ...prev.instances['inst-1']!, status: 'busy' },
        },
      }));

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('observeInstances', () => {
    it('calls onAdded when a new instance appears', () => {
      const onAdded = vi.fn();
      observeInstances(store, { onAdded });

      const slice = makeSlice('inst-1');
      store.setState((prev) => ({
        ...prev,
        instances: { 'inst-1': slice },
      }));

      expect(onAdded).toHaveBeenCalledOnce();
      expect(onAdded).toHaveBeenCalledWith(slice);
    });

    it('calls onRemoved when an instance disappears', () => {
      const slice = makeSlice('inst-1');
      store.setState((prev) => ({
        ...prev,
        instances: { 'inst-1': slice },
      }));

      const onRemoved = vi.fn();
      observeInstances(store, { onRemoved });

      store.setState((prev) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { 'inst-1': _removed, ...rest } = prev.instances;
        return { ...prev, instances: rest };
      });

      expect(onRemoved).toHaveBeenCalledOnce();
      expect(onRemoved).toHaveBeenCalledWith('inst-1');
    });

    it('does not call onAdded for instances that already existed', () => {
      store.setState((prev) => ({
        ...prev,
        instances: { 'inst-1': makeSlice('inst-1') },
      }));

      const onAdded = vi.fn();
      observeInstances(store, { onAdded });

      // Mutate an existing instance field — not an addition
      store.setState((prev) => ({
        ...prev,
        instances: {
          'inst-1': { ...prev.instances['inst-1']!, status: 'busy' },
        },
      }));

      expect(onAdded).not.toHaveBeenCalled();
    });

    it('returns an unsubscribe function', () => {
      const onAdded = vi.fn();
      const unsub = observeInstances(store, { onAdded });
      unsub();

      store.setState((prev) => ({
        ...prev,
        instances: { 'inst-1': makeSlice('inst-1') },
      }));

      expect(onAdded).not.toHaveBeenCalled();
    });
  });

  describe('observeGlobal', () => {
    it('calls callback when a global field changes', () => {
      const cb = vi.fn();
      observeGlobal(store, 'memoryPressure', cb);

      store.setState((prev) => ({
        ...prev,
        global: { ...prev.global, memoryPressure: 'warning' },
      }));

      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith('warning');
    });

    it('does not call callback when a different global field changes', () => {
      const cb = vi.fn();
      observeGlobal(store, 'memoryPressure', cb);

      store.setState((prev) => ({
        ...prev,
        global: { ...prev.global, activeTaskCount: 5 },
      }));

      expect(cb).not.toHaveBeenCalled();
    });

    it('returns an unsubscribe function', () => {
      const cb = vi.fn();
      const unsub = observeGlobal(store, 'creationPaused', cb);
      unsub();

      store.setState((prev) => ({
        ...prev,
        global: { ...prev.global, creationPaused: true },
      }));

      expect(cb).not.toHaveBeenCalled();
    });
  });
});
