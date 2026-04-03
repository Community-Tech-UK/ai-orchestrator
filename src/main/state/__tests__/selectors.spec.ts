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
