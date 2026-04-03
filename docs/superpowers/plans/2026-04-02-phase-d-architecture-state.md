# Phase D: Architecture & State Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an immutable store for centralized main-process state and narrow dependency injection interfaces for the core execution loop, reducing EventEmitter spaghetti and improving testability.

**Architecture:** The immutable store is a centralization layer alongside existing singletons — not a replacement. It provides cross-cutting queries, change detection, and observer-based side effects. The narrow DI extends the existing LifecycleDependencies pattern to decouple InstanceLifecycleManager from direct singleton access.

**Tech Stack:** TypeScript 5.9, Vitest, Node.js EventEmitter

---

## Dependencies

Phase D depends on Phase A (sequential wrapper from `src/main/util/sequential.ts`). The `sequential.ts` file must exist before implementing the store. The store's `setState` uses an in-process re-entrancy guard (the `updating` flag) rather than the async sequential wrapper, because `setState` is synchronous. However, callers that need to protect async operations around `setState` (e.g. loading data then writing to store) should wrap those operations with `sequential()` from Phase A.

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/main/state/store.ts` | Generic immutable store — `createStore<T>()` factory |
| Create | `src/main/state/app-state.ts` | `AppState` type + `InstanceSlice` type + `INITIAL_APP_STATE` |
| Create | `src/main/state/selectors.ts` | Pure derivation functions over `AppState` |
| Create | `src/main/state/observers.ts` | Helper wiring — field watchers, add/remove watchers, global watchers |
| Create | `src/main/state/index.ts` | Singleton store + convenience mutators + `_resetStoreForTesting()` |
| Create | `src/main/state/__tests__/store.spec.ts` | Tests for `createStore` — subscribe, setState, re-entrancy guard |
| Create | `src/main/state/__tests__/selectors.spec.ts` | Tests for all selector pure functions |
| Create | `src/main/state/__tests__/observers.spec.ts` | Tests for observer helpers — field/add/remove/global change |
| Create | `src/main/instance/instance-deps.ts` | Narrow `CoreDeps` interfaces + `productionCoreDeps()` factory |
| Create | `src/main/instance/__tests__/instance-deps.spec.ts` | Tests for `CoreDeps` shape + mock wiring |
| Modify | `src/main/instance/instance-lifecycle.ts` | Add optional `coreDeps?: CoreDeps` to `LifecycleDependencies` |
| Modify | `src/main/instance/instance-manager.ts` | Pass `productionCoreDeps()` when constructing `InstanceLifecycleManager` |

---

## Task D1: Immutable Store for Main Process State

**Files:**
- Create: `src/main/state/store.ts`
- Create: `src/main/state/app-state.ts`
- Create: `src/main/state/selectors.ts`
- Create: `src/main/state/observers.ts`
- Create: `src/main/state/index.ts`
- Create: `src/main/state/__tests__/store.spec.ts`
- Create: `src/main/state/__tests__/selectors.spec.ts`
- Create: `src/main/state/__tests__/observers.spec.ts`

---

### Step D1.1: Write store tests

- [ ] Create `src/main/state/__tests__/store.spec.ts`:

```typescript
// src/main/state/__tests__/store.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStore, type Store } from '../store';

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
      let unsub: () => void;
      unsub = store.subscribe(() => unsub()); // self-unsubscribes
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
```

### Step D1.2: Implement `store.ts`

- [ ] Create `src/main/state/store.ts`:

```typescript
// src/main/state/store.ts

export interface Store<T> {
  getState(): Readonly<T>;
  setState(updater: (prev: Readonly<T>) => T): void;
  subscribe(listener: (state: Readonly<T>, prev: Readonly<T>) => void): () => void;
}

export function createStore<T>(initialState: T): Store<T> {
  let state = initialState;
  let updating = false;
  const listeners = new Set<(state: Readonly<T>, prev: Readonly<T>) => void>();

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
        for (const listener of listeners) {
          listener(state, prev);
        }
      } finally {
        updating = false;
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
```

### Step D1.3: Run store tests — verify they pass

- [ ] Run: `npx vitest run src/main/state/__tests__/store.spec.ts --reporter=verbose`
- [ ] All tests must pass before proceeding.

---

### Step D1.4: Write `app-state.ts`

- [ ] Create `src/main/state/app-state.ts`:

```typescript
// src/main/state/app-state.ts
import type { InstanceStatus, ContextUsage, InstanceProvider } from '../../shared/types/instance.types';

export interface InstanceSlice {
  id: string;
  displayName: string;
  status: InstanceStatus;
  contextUsage: ContextUsage;
  lastActivity: number;
  provider: InstanceProvider;
  currentModel?: string;
  parentId: string | null;
  childrenIds: string[];
  agentId: string;
  workingDirectory: string;
  processId: number | null;
  errorCount: number;
  totalTokensUsed: number;
}

export interface AppState {
  instances: Record<string, InstanceSlice>;
  global: {
    memoryPressure: 'normal' | 'warning' | 'critical';
    creationPaused: boolean;
    activeTaskCount: number;
    shutdownRequested: boolean;
  };
}

export const INITIAL_APP_STATE: AppState = {
  instances: {},
  global: {
    memoryPressure: 'normal',
    creationPaused: false,
    activeTaskCount: 0,
    shutdownRequested: false,
  },
};
```

---

### Step D1.5: Write selector tests

- [ ] Create `src/main/state/__tests__/selectors.spec.ts`:

```typescript
// src/main/state/__tests__/selectors.spec.ts
import { describe, it, expect } from 'vitest';
import {
  selectInstance,
  selectAllInstances,
  selectByStatus,
  selectCanCreate,
  selectInstanceCount,
  selectTotalTokens,
} from '../selectors';
import { INITIAL_APP_STATE, type AppState, type InstanceSlice } from '../app-state';

function makeSlice(overrides: Partial<InstanceSlice> = {}): InstanceSlice {
  return {
    id: 'inst-1',
    displayName: 'Test',
    status: 'idle',
    contextUsage: { used: 100, total: 200_000, percentage: 0.05 },
    lastActivity: Date.now(),
    provider: 'claude',
    parentId: null,
    childrenIds: [],
    agentId: 'build',
    workingDirectory: '/tmp',
    processId: null,
    errorCount: 0,
    totalTokensUsed: 500,
    ...overrides,
  };
}

function stateWith(instances: InstanceSlice[]): AppState {
  return {
    ...INITIAL_APP_STATE,
    instances: Object.fromEntries(instances.map((s) => [s.id, s])),
  };
}

describe('selectors', () => {
  describe('selectInstance', () => {
    it('returns the instance by id', () => {
      const slice = makeSlice({ id: 'a' });
      const state = stateWith([slice]);
      expect(selectInstance(state, 'a')).toBe(slice);
    });

    it('returns undefined for unknown id', () => {
      expect(selectInstance(INITIAL_APP_STATE, 'missing')).toBeUndefined();
    });
  });

  describe('selectAllInstances', () => {
    it('returns empty array for empty state', () => {
      expect(selectAllInstances(INITIAL_APP_STATE)).toEqual([]);
    });

    it('returns all instances as array', () => {
      const a = makeSlice({ id: 'a' });
      const b = makeSlice({ id: 'b' });
      const result = selectAllInstances(stateWith([a, b]));
      expect(result).toHaveLength(2);
      expect(result).toContain(a);
      expect(result).toContain(b);
    });
  });

  describe('selectByStatus', () => {
    it('returns only instances matching the given status', () => {
      const idle = makeSlice({ id: 'a', status: 'idle' });
      const busy = makeSlice({ id: 'b', status: 'busy' });
      const state = stateWith([idle, busy]);
      expect(selectByStatus(state, 'idle')).toEqual([idle]);
      expect(selectByStatus(state, 'busy')).toEqual([busy]);
    });

    it('returns empty array when no instances match', () => {
      const state = stateWith([makeSlice({ id: 'a', status: 'idle' })]);
      expect(selectByStatus(state, 'error')).toEqual([]);
    });
  });

  describe('selectCanCreate', () => {
    it('returns true when instance count is below max', () => {
      expect(selectCanCreate(stateWith([makeSlice({ id: 'a' })]), 5)).toBe(true);
    });

    it('returns false when instance count equals max', () => {
      const slices = ['a', 'b', 'c'].map((id) => makeSlice({ id }));
      expect(selectCanCreate(stateWith(slices), 3)).toBe(false);
    });

    it('returns false when creationPaused is true regardless of count', () => {
      const state: AppState = {
        ...stateWith([]),
        global: { ...INITIAL_APP_STATE.global, creationPaused: true },
      };
      expect(selectCanCreate(state, 100)).toBe(false);
    });

    it('returns false when shutdownRequested', () => {
      const state: AppState = {
        ...stateWith([]),
        global: { ...INITIAL_APP_STATE.global, shutdownRequested: true },
      };
      expect(selectCanCreate(state, 100)).toBe(false);
    });
  });

  describe('selectInstanceCount', () => {
    it('returns 0 for empty state', () => {
      expect(selectInstanceCount(INITIAL_APP_STATE)).toBe(0);
    });

    it('returns the number of instances', () => {
      const state = stateWith([makeSlice({ id: 'a' }), makeSlice({ id: 'b' })]);
      expect(selectInstanceCount(state)).toBe(2);
    });
  });

  describe('selectTotalTokens', () => {
    it('returns 0 for empty state', () => {
      expect(selectTotalTokens(INITIAL_APP_STATE)).toBe(0);
    });

    it('sums totalTokensUsed across all instances', () => {
      const a = makeSlice({ id: 'a', totalTokensUsed: 1000 });
      const b = makeSlice({ id: 'b', totalTokensUsed: 2500 });
      expect(selectTotalTokens(stateWith([a, b]))).toBe(3500);
    });
  });
});
```

### Step D1.6: Implement `selectors.ts`

- [ ] Create `src/main/state/selectors.ts`:

```typescript
// src/main/state/selectors.ts
import type { AppState, InstanceSlice } from './app-state';
import type { InstanceStatus } from '../../shared/types/instance.types';

export function selectInstance(state: AppState, id: string): InstanceSlice | undefined {
  return state.instances[id];
}

export function selectAllInstances(state: AppState): InstanceSlice[] {
  return Object.values(state.instances);
}

export function selectByStatus(state: AppState, status: InstanceStatus): InstanceSlice[] {
  return Object.values(state.instances).filter((s) => s.status === status);
}

export function selectCanCreate(state: AppState, maxInstances: number): boolean {
  if (state.global.creationPaused) return false;
  if (state.global.shutdownRequested) return false;
  return Object.keys(state.instances).length < maxInstances;
}

export function selectInstanceCount(state: AppState): number {
  return Object.keys(state.instances).length;
}

export function selectTotalTokens(state: AppState): number {
  return Object.values(state.instances).reduce((sum, s) => sum + s.totalTokensUsed, 0);
}
```

### Step D1.7: Run selector tests — verify they pass

- [ ] Run: `npx vitest run src/main/state/__tests__/selectors.spec.ts --reporter=verbose`
- [ ] All tests must pass before proceeding.

---

### Step D1.8: Write observer tests

- [ ] Create `src/main/state/__tests__/observers.spec.ts`:

```typescript
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
```

### Step D1.9: Implement `observers.ts`

- [ ] Create `src/main/state/observers.ts`:

```typescript
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
```

### Step D1.10: Run observer tests — verify they pass

- [ ] Run: `npx vitest run src/main/state/__tests__/observers.spec.ts --reporter=verbose`
- [ ] All tests must pass before proceeding.

---

### Step D1.11: Implement the singleton `index.ts`

- [ ] Create `src/main/state/index.ts`:

```typescript
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
```

---

### Step D1.12: Wire store into `src/main/index.ts` — shadow events (additive only)

The existing EventEmitter wiring in `setupInstanceEventForwarding()` (lines 399–598 of `src/main/index.ts`) stays intact. This step adds store mirroring that runs alongside it — no existing lines are removed.

- [ ] Open `src/main/index.ts` and read the import block at the top to confirm the current imports.
- [ ] Add the following import near the other state/store imports at the top of the file:

```typescript
import { getAppStore, addInstance, removeInstance, updateInstance, setGlobalState } from './state';
import type { InstanceSlice } from './state';
import type { Instance } from './shared/types/instance.types';
```

- [ ] Locate the `setupInstanceEventForwarding()` method. At the **very end** of that method (after all existing listener registrations), add the shadow wiring block:

```typescript
// ── Shadow events into immutable store (additive — existing wiring above unchanged) ──

function toSlice(instance: Instance): InstanceSlice {
  return {
    id: instance.id,
    displayName: instance.displayName,
    status: instance.status,
    contextUsage: instance.contextUsage,
    lastActivity: instance.lastActivity,
    provider: instance.provider,
    currentModel: instance.currentModel,
    parentId: instance.parentId,
    childrenIds: instance.childrenIds,
    agentId: instance.agentId,
    workingDirectory: instance.workingDirectory,
    processId: instance.processId,
    errorCount: instance.errorCount,
    totalTokensUsed: instance.totalTokensUsed,
  };
}

this.instanceManager.on('instance:created', (instance: Instance) => {
  try { addInstance(toSlice(instance)); } catch { /* store failure must not block main flow */ }
});

this.instanceManager.on('instance:removed', (instanceId: string) => {
  try { removeInstance(instanceId); } catch { /* non-critical */ }
});

this.instanceManager.on('instance:state-update', (update: Record<string, unknown>) => {
  const id = update['instanceId'] as string | undefined;
  if (!id) return;
  const instance = this.instanceManager.getInstance(id);
  if (!instance) return;
  try { updateInstance(id, toSlice(instance)); } catch { /* non-critical */ }
});

this.instanceManager.on('instance:batch-update', (payload: {
  updates?: { instanceId: string; status?: string; contextUsage?: { used: number; total: number; percentage: number } }[]
}) => {
  if (!payload.updates) return;
  for (const update of payload.updates) {
    const partial: Partial<InstanceSlice> = {};
    if (update.status) partial.status = update.status as InstanceSlice['status'];
    if (update.contextUsage) partial.contextUsage = update.contextUsage;
    try { updateInstance(update.instanceId, partial); } catch { /* non-critical */ }
  }
});
```

- [ ] Locate where ResourceGovernor events are handled (search for `'memory:warning'` or `'memory:critical'`). Add store mirroring for memory pressure:

```typescript
// Mirror memory pressure into the global app store
const memMonitor = getMemoryMonitor();
memMonitor.on('memory:warning', () => {
  try { setGlobalState({ memoryPressure: 'warning' }); } catch { /* non-critical */ }
});
memMonitor.on('memory:critical', () => {
  try { setGlobalState({ memoryPressure: 'critical' }); } catch { /* non-critical */ }
});
memMonitor.on('memory:normal', () => {
  try { setGlobalState({ memoryPressure: 'normal' }); } catch { /* non-critical */ }
});
```

- [ ] On app shutdown, set `shutdownRequested: true` in the store. Locate the `shutdown()` method in the `App` class and add as the first line of the method body:

```typescript
try { setGlobalState({ shutdownRequested: true }); } catch { /* non-critical */ }
```

---

### Step D1.13: TypeScript and lint check for D1

- [ ] Run: `npx tsc --noEmit`
- [ ] Run: `npx tsc --noEmit -p tsconfig.spec.json`
- [ ] Run: `npx eslint src/main/state/ src/main/index.ts`
- [ ] Fix all errors before marking D1 complete.

---

## Task D2: Narrow DI for Core Execution Loop

**Files:**
- Create: `src/main/instance/instance-deps.ts`
- Create: `src/main/instance/__tests__/instance-deps.spec.ts`
- Modify: `src/main/instance/instance-lifecycle.ts` (add `coreDeps?: CoreDeps` to `LifecycleDependencies`)
- Modify: `src/main/instance/instance-manager.ts` (pass `productionCoreDeps()` in lifecycle constructor)

---

### Step D2.1: Read the files to be modified

- [ ] Read `src/main/instance/instance-lifecycle.ts` lines 1–221 to confirm the current `LifecycleDependencies` shape and all direct singleton calls within `InstanceLifecycleManager`.
- [ ] Read `src/main/instance/instance-manager.ts` lines 190–225 to confirm the exact bindings passed to `new InstanceLifecycleManager(...)`.
- [ ] Read `src/main/agents/agent-registry.ts` lines 60–130 to identify the public methods used by lifecycle: `resolve()`, `getById()`, `getDefault()`, `getAll()`.
- [ ] Read `src/main/process/supervisor-tree.ts` lines 140–240 to identify the public methods used: `registerInstance()`, `unregisterInstance()`.
- [ ] Read `src/main/session/session-continuity.ts` lines 180–280 to identify the methods called: `updateState()`, `createSnapshot()`.
- [ ] Read `src/main/security/permission-manager.ts` lines 60–150 to identify the method signature for `loadProjectRules()`.
- [ ] Read `src/main/observation/policy-adapter.ts` lines 45–90 to identify the method called: `buildContext()`.
- [ ] Read `src/main/memory/memory-monitor.ts` lines 60–110 to identify `getCurrentPressureLevel()` or equivalent.
- [ ] Read `src/main/history/history-manager.ts` lines 60–130 to identify the method called during instance creation.

> Note: Do NOT skip any of the reads above. The exact method signatures must be confirmed before writing types.

---

### Step D2.2: Write `instance-deps.spec.ts` first (TDD)

- [ ] Create `src/main/instance/__tests__/instance-deps.spec.ts`:

```typescript
// src/main/instance/__tests__/instance-deps.spec.ts
import { describe, it, expect, vi } from 'vitest';
import type { CoreDeps, AgentDeps, SettingsDeps, SupervisionDeps, SessionDeps, PermissionDeps, ObservationDeps, MemoryDeps, HistoryDeps } from '../instance-deps';

// ── Shape tests ─────────────────────────────────────────────────────────────
// These verify that the interfaces are structurally correct and that
// mock implementations satisfy them — no singleton initialization required.

describe('CoreDeps interfaces', () => {
  it('AgentDeps can be implemented with vi.fn()', () => {
    const deps: AgentDeps = {
      resolveAgent: vi.fn().mockResolvedValue({}),
      getAgentById: vi.fn().mockReturnValue(undefined),
      getDefaultAgent: vi.fn().mockReturnValue({ id: 'build', name: 'Build' }),
    };
    expect(deps.resolveAgent).toBeDefined();
    expect(deps.getAgentById).toBeDefined();
    expect(deps.getDefaultAgent).toBeDefined();
  });

  it('SettingsDeps can be implemented with vi.fn()', () => {
    const deps: SettingsDeps = {
      getAll: vi.fn().mockReturnValue({}),
    };
    expect(deps.getAll).toBeDefined();
  });

  it('SupervisionDeps can be implemented with vi.fn()', () => {
    const deps: SupervisionDeps = {
      registerInstance: vi.fn(),
      unregisterInstance: vi.fn(),
    };
    expect(deps.registerInstance).toBeDefined();
    expect(deps.unregisterInstance).toBeDefined();
  });

  it('SessionDeps can be implemented with vi.fn()', () => {
    const deps: SessionDeps = {
      updateState: vi.fn(),
      createSnapshot: vi.fn().mockResolvedValue('snap-1'),
    };
    expect(deps.updateState).toBeDefined();
    expect(deps.createSnapshot).toBeDefined();
  });

  it('PermissionDeps can be implemented with vi.fn()', () => {
    const deps: PermissionDeps = {
      loadProjectRules: vi.fn().mockResolvedValue([]),
    };
    expect(deps.loadProjectRules).toBeDefined();
  });

  it('ObservationDeps can be implemented with vi.fn()', () => {
    const deps: ObservationDeps = {
      buildContext: vi.fn().mockReturnValue(''),
    };
    expect(deps.buildContext).toBeDefined();
  });

  it('MemoryDeps can be implemented with vi.fn()', () => {
    const deps: MemoryDeps = {
      getCurrentPressure: vi.fn().mockReturnValue('normal'),
    };
    expect(deps.getCurrentPressure).toBeDefined();
  });

  it('HistoryDeps can be implemented with vi.fn()', () => {
    const deps: HistoryDeps = {
      addThread: vi.fn(),
    };
    expect(deps.addThread).toBeDefined();
  });

  it('CoreDeps assembles all sub-deps', () => {
    const deps: CoreDeps = {
      agents: {
        resolveAgent: vi.fn().mockResolvedValue({}),
        getAgentById: vi.fn().mockReturnValue(undefined),
        getDefaultAgent: vi.fn().mockReturnValue({ id: 'build', name: 'Build' }),
      },
      settings: { getAll: vi.fn().mockReturnValue({}) },
      supervision: {
        registerInstance: vi.fn(),
        unregisterInstance: vi.fn(),
      },
      session: {
        updateState: vi.fn(),
        createSnapshot: vi.fn().mockResolvedValue('snap-1'),
      },
      permissions: { loadProjectRules: vi.fn().mockResolvedValue([]) },
      observation: { buildContext: vi.fn().mockReturnValue('') },
      memory: { getCurrentPressure: vi.fn().mockReturnValue('normal') },
      history: { addThread: vi.fn() },
    };

    // Verify each group is present and callable
    expect(deps.agents.getDefaultAgent()).toMatchObject({ id: 'build' });
    expect(deps.settings.getAll()).toBeDefined();
    deps.supervision.registerInstance('inst-1', null);
    expect(deps.supervision.registerInstance).toHaveBeenCalledWith('inst-1', null);
    expect(deps.memory.getCurrentPressure()).toBe('normal');
  });
});

// ── productionCoreDeps structural test ──────────────────────────────────────
// We only verify the shape is correct (all keys present).
// We do NOT call the function because it would initialize singletons.

describe('productionCoreDeps export', () => {
  it('is exported as a function', async () => {
    // Dynamic import to avoid singleton side-effects at describe time
    const mod = await import('../instance-deps');
    expect(typeof mod.productionCoreDeps).toBe('function');
  });
});
```

### Step D2.3: Implement `instance-deps.ts`

- [ ] Read the following files to confirm exact method signatures before writing (required — do not skip):
  - `src/main/agents/agent-registry.ts` — public API for `resolve()`, `getById()`, `getDefault()`, `getAll()`
  - `src/main/process/supervisor-tree.ts` — public API for `registerInstance()`, `unregisterInstance()`
  - `src/main/session/session-continuity.ts` — public API for `updateState()`, `createSnapshot()`
  - `src/main/security/permission-manager.ts` — public API for loading project rules
  - `src/main/observation/policy-adapter.ts` — public API for `buildContext()`
  - `src/main/memory/memory-monitor.ts` — method that returns `MemoryPressureLevel`
  - `src/main/history/history-manager.ts` — relevant method for history thread creation

- [ ] Create `src/main/instance/instance-deps.ts`. Use the exact signatures found in the reads above. The structure is:

```typescript
// src/main/instance/instance-deps.ts

import type { AgentProfile } from '../../shared/types/agent.types';
import type { AppSettings } from '../../shared/types/settings.types';
import type { PermissionRule } from '../security/permission-manager';
import type { MemoryPressureLevel } from '../memory/memory-monitor';
import type { SessionState } from '../session/session-continuity';

// ── Per-concern narrow interfaces ────────────────────────────────────────────

export interface AgentDeps {
  /** Resolve an agent by ID for a given working directory. */
  resolveAgent(agentId: string, workDir: string): Promise<AgentProfile>;
  /** Look up an agent profile by its ID (returns undefined if not found). */
  getAgentById(id: string): AgentProfile | undefined;
  /** Return the default agent profile. */
  getDefaultAgent(): AgentProfile;
}

export interface SettingsDeps {
  /** Return the full application settings snapshot. */
  getAll(): AppSettings;
}

export interface SupervisionDeps {
  /** Register an instance with the supervisor tree. */
  registerInstance(id: string, parentId: string | null): void;
  /** Remove an instance from the supervisor tree. */
  unregisterInstance(id: string): void;
}

export interface SessionDeps {
  /** Update persisted session state for an instance. */
  updateState(instanceId: string, state: Partial<SessionState>): void;
  /** Create a named snapshot for an instance. Returns the snapshot ID. */
  createSnapshot(
    instanceId: string,
    name: string,
    description: string,
    trigger: 'auto' | 'manual' | 'checkpoint',
  ): Promise<string>;
}

export interface PermissionDeps {
  /** Load project-level permission rules for a working directory. */
  loadProjectRules(workDir: string): Promise<PermissionRule[]>;
}

export interface ObservationDeps {
  /** Build an observation context string for injection into agent prompts. */
  buildContext(instanceId: string): string;
}

export interface MemoryDeps {
  /** Return the current memory pressure level. */
  getCurrentPressure(): MemoryPressureLevel;
}

export interface HistoryDeps {
  /** Register a new history thread for an instance. */
  addThread(instanceId: string): void;
}

/** Aggregated narrow deps for the core execution loop. */
export interface CoreDeps {
  agents: AgentDeps;
  settings: SettingsDeps;
  supervision: SupervisionDeps;
  session: SessionDeps;
  permissions: PermissionDeps;
  observation: ObservationDeps;
  memory: MemoryDeps;
  history: HistoryDeps;
}

// ── Production wiring ────────────────────────────────────────────────────────
// Calling this function is deferred to runtime so that singletons are not
// initialized at module load time (avoids import-side-effect problems in tests).

export function productionCoreDeps(): CoreDeps {
  // Lazy imports inside the function body keep them out of the module-level scope.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAgentRegistry } = require('../agents/agent-registry') as typeof import('../agents/agent-registry');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSettingsManager } = require('../core/config/settings-manager') as typeof import('../core/config/settings-manager');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSupervisorTree } = require('../process') as typeof import('../process');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSessionContinuityManager } = require('../session/session-continuity') as typeof import('../session/session-continuity');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getPermissionManager } = require('../security/permission-manager') as typeof import('../security/permission-manager');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getPolicyAdapter } = require('../observation/policy-adapter') as typeof import('../observation/policy-adapter');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getMemoryMonitor } = require('../memory') as typeof import('../memory');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getHistoryManager } = require('../history') as typeof import('../history');

  return {
    agents: {
      resolveAgent: (id, wd) => getAgentRegistry().resolve(id, wd),
      getAgentById: (id) => getAgentRegistry().getById(id),
      getDefaultAgent: () => getAgentRegistry().getDefault(),
    },
    settings: {
      getAll: () => getSettingsManager().getAll(),
    },
    supervision: {
      registerInstance: (id, parentId) => getSupervisorTree().registerInstance(id, parentId),
      unregisterInstance: (id) => getSupervisorTree().unregisterInstance(id),
    },
    session: {
      updateState: (id, state) => getSessionContinuityManager().updateState(id, state),
      createSnapshot: (id, name, desc, trigger) =>
        getSessionContinuityManager().createSnapshot(id, name, desc, trigger),
    },
    permissions: {
      loadProjectRules: (wd) => getPermissionManager().loadProjectRules(wd),
    },
    observation: {
      buildContext: (id) => getPolicyAdapter().buildContext(id),
    },
    memory: {
      getCurrentPressure: () => getMemoryMonitor().getPressureLevel(),
    },
    history: {
      addThread: (id) => getHistoryManager().addThread(id),
    },
  };
}
```

> **Important:** After writing this file, run TypeScript to verify the method names are correct. If a method does not exist on the real singleton (e.g. `resolve`, `getById`, `getDefault`, `getPressureLevel`, `addThread`), look up the correct method name in the file read above and fix it before proceeding. The method names in this template are illustrative — the real names must come from your reads.

---

### Step D2.4: Run `instance-deps` tests — verify they pass

- [ ] Run: `npx vitest run src/main/instance/__tests__/instance-deps.spec.ts --reporter=verbose`
- [ ] All tests must pass before proceeding.

---

### Step D2.5: Extend `LifecycleDependencies` with optional `coreDeps`

- [ ] Read `src/main/instance/instance-lifecycle.ts` lines 147–181 (the `LifecycleDependencies` interface).
- [ ] Add the optional field at the end of the interface, just before the closing `}`:

```typescript
  /**
   * Narrow dependency interfaces for the core execution loop.
   * When provided, lifecycle methods should prefer these over direct singleton access.
   * Optional for backward compatibility — existing code paths continue to work.
   */
  coreDeps?: CoreDeps;
```

- [ ] Add the import for `CoreDeps` at the top of `instance-lifecycle.ts`, near the existing singleton imports:

```typescript
import type { CoreDeps } from './instance-deps';
```

---

### Step D2.6: Update `InstanceManager` to pass `productionCoreDeps()`

- [ ] Read `src/main/instance/instance-manager.ts` lines 40–50 (imports block) and 190–225 (lifecycle constructor call).
- [ ] Add the import near the other imports in `instance-manager.ts`:

```typescript
import { productionCoreDeps } from './instance-deps';
```

- [ ] Locate the `new InstanceLifecycleManager({...})` call (around line 191). Add `coreDeps: productionCoreDeps()` as the last property in the passed object, just before the closing `})`:

```typescript
      coreDeps: productionCoreDeps(),
```

The resulting tail of the constructor call should look like:

```typescript
      getStateMachine: (id) => this.state.getStateMachine(id),
      setStateMachine: (id, machine) => this.state.setStateMachine(id, machine),
      deleteStateMachine: (id) => this.state.deleteStateMachine(id),
      coreDeps: productionCoreDeps(),
    });
```

---

### Step D2.7: TypeScript and lint check for D2

- [ ] Run: `npx tsc --noEmit`
- [ ] Run: `npx tsc --noEmit -p tsconfig.spec.json`
- [ ] Run: `npx eslint src/main/instance/instance-deps.ts src/main/instance/instance-lifecycle.ts src/main/instance/instance-manager.ts`
- [ ] Fix all errors. If method names in `productionCoreDeps()` do not match actual singleton APIs, correct them now and re-run.

---

## Final Verification Checklist

After completing all steps:

- [ ] Run full test suite: `npx vitest run src/main/state/ src/main/instance/__tests__/instance-deps.spec.ts --reporter=verbose`
- [ ] Run full TypeScript check: `npx tsc --noEmit`
- [ ] Run spec TypeScript check: `npx tsc --noEmit -p tsconfig.spec.json`
- [ ] Run lint: `npm run lint`
- [ ] Verify no existing tests were broken: `npx vitest run src/main/instance/__tests__/instance-manager.spec.ts --reporter=verbose`

**Each item in this checklist must pass with zero errors before marking Phase D complete.**

---

## Implementation Notes

### What Phase D does NOT do

- It does not remove or replace any existing EventEmitter wiring in `src/main/index.ts`.
- It does not migrate `InstanceLifecycleManager` to use `CoreDeps` internally — that is a follow-up phase. The `coreDeps` field is wired and available, but internal methods still call singletons directly. Tests can now inject mocks via `coreDeps`.
- It does not add persistence to the store — state is in-memory only and resets on restart.

### Store mutation safety

`setState` is synchronous and protected by the `updating` re-entrancy guard. For callers that need to perform async work before writing to the store (e.g. fetch data then update), use `sequential()` from `src/main/util/sequential.ts` to serialize those async paths externally.

### Backward compatibility

Both changes are strictly additive:
- `coreDeps?: CoreDeps` is optional in `LifecycleDependencies` — all existing call sites that do not pass it continue to work.
- Store observers in `src/main/index.ts` are wrapped in `try/catch` — a store failure never propagates to the EventEmitter path.
