/**
 * Replay-fallback child reconciliation (resilient-threads Phase 4): after a
 * fresh restart the parent's orchestration children are reconciled — dead or
 * missing children dropped (but kept queryable as completed), live ones kept —
 * and the parent Instance.childrenIds mirror stays in sync.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Instance } from '../../../shared/types/instance.types';
import { InstanceOrchestrationManager } from '../instance-orchestration';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../memory', () => ({
  getUnifiedMemory: () => ({
    recordTaskOutcome: vi.fn(),
  }),
}));

vi.mock('../../learning/outcome-tracker', () => ({
  OutcomeTracker: {
    getInstance: () => ({
      recordOutcome: vi.fn(),
    }),
  },
}));

vi.mock('../../learning/strategy-learner', () => ({
  StrategyLearner: {
    getInstance: () => ({
      getRecommendation: vi.fn(() => null),
    }),
  },
}));

vi.mock('../../learning/preference-store', () => ({
  getPreferenceStore: () => ({
    get: vi.fn(() => undefined),
  }),
}));

function makeInstance(overrides: Partial<Instance>): Instance {
  return {
    id: 'inst',
    status: 'idle',
    displayName: 'instance',
    childrenIds: [],
    ...overrides,
  } as unknown as Instance;
}

function createManager(instances: Map<string, Instance>): InstanceOrchestrationManager {
  return new InstanceOrchestrationManager({
    getInstance: (id) => instances.get(id),
    getInstanceCount: vi.fn(() => instances.size),
    createChildInstance: vi.fn(),
    sendInput: vi.fn(),
    terminateInstance: vi.fn(),
    getAdapter: vi.fn(),
  });
}

describe('InstanceOrchestrationManager.reconcileChildrenAfterRestart', () => {
  it('returns null for an instance with no orchestration context', () => {
    const manager = createManager(new Map<string, Instance>());

    expect(manager.reconcileChildrenAfterRestart('unknown')).toBeNull();
  });

  it('keeps live children, drops dead/missing ones, and syncs the parent instance', () => {
    const parent = makeInstance({
      id: 'parent',
      childrenIds: ['child-live', 'child-dead', 'child-gone'],
    });
    const instances = new Map<string, Instance>([
      ['parent', parent],
      ['child-live', makeInstance({ id: 'child-live', displayName: 'researcher', status: 'busy' })],
      ['child-dead', makeInstance({ id: 'child-dead', status: 'terminated' })],
      // child-gone is absent from the map entirely (already deleted).
    ]);
    const manager = createManager(instances);
    manager.registerInstance('parent', '/tmp', null);
    const handler = manager.getOrchestrationHandler();
    handler.addChild('parent', 'child-live');
    handler.addChild('parent', 'child-dead');
    handler.addChild('parent', 'child-gone');

    const result = manager.reconcileChildrenAfterRestart('parent');

    expect(result).toEqual({
      activeChildren: [{ id: 'child-live', name: 'researcher', status: 'busy' }],
      droppedChildIds: ['child-dead', 'child-gone'],
    });
    expect(parent.childrenIds).toEqual(['child-live']);
    expect(handler.isChildOfParent('parent', 'child-live')).toBe(true);
    expect(handler.getCompletedChildIds('parent').sort()).toEqual(['child-dead', 'child-gone']);
  });

  it('leaves everything untouched when all children are alive', () => {
    const parent = makeInstance({ id: 'parent', childrenIds: ['child-a'] });
    const instances = new Map<string, Instance>([
      ['parent', parent],
      ['child-a', makeInstance({ id: 'child-a', displayName: 'worker', status: 'processing' })],
    ]);
    const manager = createManager(instances);
    manager.registerInstance('parent', '/tmp', null);
    manager.getOrchestrationHandler().addChild('parent', 'child-a');

    const result = manager.reconcileChildrenAfterRestart('parent');

    expect(result).toEqual({
      activeChildren: [{ id: 'child-a', name: 'worker', status: 'processing' }],
      droppedChildIds: [],
    });
    expect(parent.childrenIds).toEqual(['child-a']);
    expect(manager.getOrchestrationHandler().getCompletedChildIds('parent')).toEqual([]);
  });
});
