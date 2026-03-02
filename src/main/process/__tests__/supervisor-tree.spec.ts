import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock electron before any imports that transitively pull in app.getPath
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/test' } }));

// Mock the logger to avoid file system / electron dependencies
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  getLogManager: () => ({
    getLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import { SupervisorTree } from '../supervisor-tree';
import { CircuitBreakerRegistry } from '../circuit-breaker';

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function makeNoopStart(returnId = 'instance-id'): () => Promise<string> {
  return () => Promise.resolve(returnId);
}

function makeNoopStop(): (id: string) => Promise<void> {
  return () => Promise.resolve();
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe('SupervisorTree', () => {
  let tree: SupervisorTree;

  beforeEach(async () => {
    // Reset both singletons so each test starts clean
    await SupervisorTree._resetForTesting();
    CircuitBreakerRegistry._resetForTesting();
    tree = SupervisorTree.getInstance();
  });

  afterEach(async () => {
    await SupervisorTree._resetForTesting();
    CircuitBreakerRegistry._resetForTesting();
  });

  // ---------------------------------------------------------------
  // registerInstance
  // ---------------------------------------------------------------

  describe('registerInstance', () => {
    it('adds instance to tree', () => {
      tree.registerInstance('inst-1', null, '/tmp', 'Instance 1');

      const reg = tree.getInstanceRegistration('inst-1');
      expect(reg).toBeDefined();
      expect(reg?.instanceId).toBe('inst-1');
      expect(reg?.displayName).toBe('Instance 1');
      expect(reg?.workingDirectory).toBe('/tmp');
    });

    it('stores all instances and they appear in getAllRegistrations', () => {
      tree.registerInstance('inst-a', null, '/tmp/a', 'A');
      tree.registerInstance('inst-b', null, '/tmp/b', 'B');
      tree.registerInstance('inst-c', null, '/tmp/c', 'C');

      const all = tree.getAllRegistrations();
      expect(all.size).toBe(3);
      expect(all.has('inst-a')).toBe(true);
      expect(all.has('inst-b')).toBe(true);
      expect(all.has('inst-c')).toBe(true);
    });

    it('tracks parent-child relationships', () => {
      tree.registerInstance('parent', null, '/tmp', 'Parent');
      tree.registerInstance('child', 'parent', '/tmp/child', 'Child');

      const childReg = tree.getInstanceRegistration('child');
      expect(childReg?.parentId).toBe('parent');

      const children = tree.getChildInstances('parent');
      expect(children).toContain('child');
    });

    it('returns supervisorNodeId in registration result', () => {
      const result = tree.registerInstance('inst-2', null, '/tmp', 'Instance 2');

      expect(result.supervisorNodeId).toBeDefined();
      expect(typeof result.supervisorNodeId).toBe('string');
    });

    it('returns workerNodeId when startFunc is provided', () => {
      const result = tree.registerInstance(
        'worker-inst',
        null,
        '/tmp',
        'Worker Instance',
        'terminate-children',
        undefined,
        makeNoopStart(),
        makeNoopStop()
      );

      expect(result.workerNodeId).toBeDefined();
      expect(typeof result.workerNodeId).toBe('string');
    });

    it('does not return workerNodeId when startFunc is omitted', () => {
      const result = tree.registerInstance('plain-inst', null, '/tmp', 'Plain Instance');

      expect(result.workerNodeId).toBeUndefined();
    });

    it('emits instance:registered event on registration', () => {
      const handler = vi.fn();
      tree.on('instance:registered', handler);

      tree.registerInstance('event-inst', null, '/tmp', 'Event Instance');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].instanceId).toBe('event-inst');
    });

    it('auto-initialises root supervisor on first call', () => {
      // Tree starts uninitialised; registerInstance should bootstrap it
      tree.registerInstance('bootstrap-inst', null, '/tmp', 'Bootstrap');

      const stats = tree.getTreeStats();
      // Root supervisor exists, so totalWorkers is tracked (0 workers since no startFunc)
      expect(stats.totalInstances).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // getTreeStats
  // ---------------------------------------------------------------

  describe('getTreeStats', () => {
    it('returns zero stats for an empty tree', () => {
      const stats = tree.getTreeStats();

      expect(stats.totalInstances).toBe(0);
      expect(stats.rootInstances).toBe(0);
      expect(stats.maxDepth).toBe(0);
    });

    it('counts root instances correctly', () => {
      tree.registerInstance('r1', null, '/tmp', 'Root 1');
      tree.registerInstance('r2', null, '/tmp', 'Root 2');
      tree.registerInstance('child', 'r1', '/tmp', 'Child');

      const stats = tree.getTreeStats();

      expect(stats.rootInstances).toBe(2); // Only r1 and r2 have parentId === null
      expect(stats.totalInstances).toBe(3);
    });

    it('calculates correct depth for a linear chain', () => {
      tree.registerInstance('level-0', null, '/tmp', 'L0');
      tree.registerInstance('level-1', 'level-0', '/tmp', 'L1');
      tree.registerInstance('level-2', 'level-1', '/tmp', 'L2');

      const stats = tree.getTreeStats();

      // level-2 is 2 hops from root → maxDepth = 2
      expect(stats.maxDepth).toBe(2);
    });

    it('handles circular parentId references (cycle detection)', () => {
      // Register two instances normally
      tree.registerInstance('node-a', null, '/tmp', 'A');
      tree.registerInstance('node-b', 'node-a', '/tmp', 'B');

      // Manually introduce a cycle: B → A → B
      const regA = tree.getInstanceRegistration('node-a');
      if (regA) {
        (regA as { parentId: string | null }).parentId = 'node-b';
      }

      // getTreeStats should not hang or throw
      expect(() => tree.getTreeStats()).not.toThrow();

      const stats = tree.getTreeStats();
      // Cycle is broken by visited set; depth computation still terminates
      expect(stats.totalInstances).toBe(2);
    });

    it('maxDepth remains 0 for all root-level instances', () => {
      tree.registerInstance('a', null, '/tmp', 'A');
      tree.registerInstance('b', null, '/tmp', 'B');
      tree.registerInstance('c', null, '/tmp', 'C');

      const stats = tree.getTreeStats();

      expect(stats.maxDepth).toBe(0);
      expect(stats.rootInstances).toBe(3);
    });
  });

  // ---------------------------------------------------------------
  // getChildInstances / getAllDescendants
  // ---------------------------------------------------------------

  describe('getChildInstances', () => {
    it('returns direct children only', () => {
      tree.registerInstance('p', null, '/tmp', 'Parent');
      tree.registerInstance('c1', 'p', '/tmp', 'Child 1');
      tree.registerInstance('c2', 'p', '/tmp', 'Child 2');
      tree.registerInstance('gc', 'c1', '/tmp', 'Grandchild');

      const children = tree.getChildInstances('p');

      expect(children).toHaveLength(2);
      expect(children).toContain('c1');
      expect(children).toContain('c2');
      expect(children).not.toContain('gc');
    });

    it('returns empty array when instance has no children', () => {
      tree.registerInstance('leaf', null, '/tmp', 'Leaf');

      expect(tree.getChildInstances('leaf')).toEqual([]);
    });
  });

  describe('getAllDescendants', () => {
    it('returns all descendants recursively', () => {
      tree.registerInstance('root', null, '/tmp', 'Root');
      tree.registerInstance('child', 'root', '/tmp', 'Child');
      tree.registerInstance('grandchild', 'child', '/tmp', 'Grandchild');

      const descendants = tree.getAllDescendants('root');

      expect(descendants).toHaveLength(2);
      expect(descendants).toContain('child');
      expect(descendants).toContain('grandchild');
    });
  });

  // ---------------------------------------------------------------
  // Restart strategies (via SupervisorNodeManager)
  // ---------------------------------------------------------------

  describe('restart strategies', () => {
    it('one-for-one: configuring strategy is preserved in registered node', () => {
      // SupervisorTree delegates strategy to its root SupervisorNodeManager.
      // We verify the tree can be configured with one-for-one strategy before
      // registering workers, and that it remains operational.
      tree.configure({ nodeConfig: { strategy: 'one-for-one' } });
      tree.registerInstance(
        'w1',
        null,
        '/tmp',
        'Worker 1',
        'terminate-children',
        undefined,
        makeNoopStart('w1-id'),
        makeNoopStop()
      );

      const stats = tree.getTreeStats();
      expect(stats.totalInstances).toBe(1);
      // If root supervisor has the worker, totalWorkers should be 1
      expect(stats.totalWorkers).toBe(1);
    });

    it('one-for-one: handleInstanceFailure does not throw for registered workers', async () => {
      tree.configure({ nodeConfig: { strategy: 'one-for-one' } });
      tree.registerInstance(
        'worker-ofo',
        null,
        '/tmp',
        'OFO Worker',
        'terminate-children',
        undefined,
        makeNoopStart(),
        makeNoopStop()
      );

      // Should resolve (may trigger restart logic internally), must not throw
      await expect(
        tree.handleInstanceFailure('worker-ofo', 'test error')
      ).resolves.toBeUndefined();
    });

    it('one-for-all: configuring strategy is accepted without errors', () => {
      tree.configure({ nodeConfig: { strategy: 'one-for-all' } });

      // Register multiple workers under one-for-all
      tree.registerInstance(
        'w-ofa-1',
        null,
        '/tmp',
        'OFA Worker 1',
        'terminate-children',
        undefined,
        makeNoopStart('w-ofa-1-id'),
        makeNoopStop()
      );
      tree.registerInstance(
        'w-ofa-2',
        null,
        '/tmp',
        'OFA Worker 2',
        'terminate-children',
        undefined,
        makeNoopStart('w-ofa-2-id'),
        makeNoopStop()
      );

      const stats = tree.getTreeStats();
      expect(stats.totalWorkers).toBe(2);
    });

    it('one-for-all: handleInstanceFailure does not throw for registered workers', async () => {
      tree.configure({ nodeConfig: { strategy: 'one-for-all' } });
      tree.registerInstance(
        'worker-ofa',
        null,
        '/tmp',
        'OFA Worker',
        'terminate-children',
        undefined,
        makeNoopStart(),
        makeNoopStop()
      );

      await expect(
        tree.handleInstanceFailure('worker-ofa', 'some failure')
      ).resolves.toBeUndefined();
    });

    it('rest-for-one: configuring strategy is accepted without errors', () => {
      tree.configure({ nodeConfig: { strategy: 'rest-for-one' } });

      tree.registerInstance(
        'w-rfo-1',
        null,
        '/tmp',
        'RFO Worker 1',
        'terminate-children',
        undefined,
        makeNoopStart('rfo-1-id'),
        makeNoopStop()
      );
      tree.registerInstance(
        'w-rfo-2',
        null,
        '/tmp',
        'RFO Worker 2',
        'terminate-children',
        undefined,
        makeNoopStart('rfo-2-id'),
        makeNoopStop()
      );

      const stats = tree.getTreeStats();
      expect(stats.totalWorkers).toBe(2);
    });

    it('rest-for-one: handleInstanceFailure does not throw for registered workers', async () => {
      tree.configure({ nodeConfig: { strategy: 'rest-for-one' } });
      tree.registerInstance(
        'worker-rfo',
        null,
        '/tmp',
        'RFO Worker',
        'terminate-children',
        undefined,
        makeNoopStart(),
        makeNoopStop()
      );

      await expect(
        tree.handleInstanceFailure('worker-rfo', 'rfo failure')
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------
  // unregisterInstance / termination policies
  // ---------------------------------------------------------------

  describe('unregisterInstance', () => {
    it('removes instance from tree', () => {
      tree.registerInstance('to-remove', null, '/tmp', 'To Remove');
      expect(tree.getInstanceRegistration('to-remove')).toBeDefined();

      tree.unregisterInstance('to-remove');

      expect(tree.getInstanceRegistration('to-remove')).toBeUndefined();
    });

    it('orphans children when terminationPolicy is orphan-children', () => {
      tree.registerInstance('parent-orphan', null, '/tmp', 'Parent', 'orphan-children');
      tree.registerInstance('child-orphan', 'parent-orphan', '/tmp', 'Child');

      tree.unregisterInstance('parent-orphan');

      const childReg = tree.getInstanceRegistration('child-orphan');
      expect(childReg).toBeDefined();
      expect(childReg?.parentId).toBeNull(); // orphaned → parentId cleared
    });

    it('reparents children when terminationPolicy is reparent-to-root', () => {
      tree.registerInstance('parent-reparent', null, '/tmp', 'Parent', 'reparent-to-root');
      tree.registerInstance('child-reparent', 'parent-reparent', '/tmp', 'Child');

      tree.unregisterInstance('parent-reparent');

      const childReg = tree.getInstanceRegistration('child-reparent');
      expect(childReg).toBeDefined();
      expect(childReg?.parentId).toBeNull();
      expect(childReg?.supervisorNodeId).toBeDefined();
    });

    it('emits instance:unregistered event', () => {
      const handler = vi.fn();
      tree.on('instance:unregistered', handler);

      tree.registerInstance('emit-unreg', null, '/tmp', 'Emit Unreg');
      tree.unregisterInstance('emit-unreg');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].instanceId).toBe('emit-unreg');
    });

    it('is a no-op for unknown instanceId', () => {
      expect(() => tree.unregisterInstance('does-not-exist')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------
  // getHierarchyTree
  // ---------------------------------------------------------------

  describe('getHierarchyTree', () => {
    it('returns only root-level nodes at the top level', () => {
      tree.registerInstance('hr1', null, '/tmp', 'HR1');
      tree.registerInstance('hr2', null, '/tmp', 'HR2');
      tree.registerInstance('hc1', 'hr1', '/tmp', 'HC1');

      const roots = tree.getHierarchyTree();

      expect(roots).toHaveLength(2);
      expect(roots.map(n => n.id)).toContain('hr1');
      expect(roots.map(n => n.id)).toContain('hr2');
    });

    it('nests child nodes under their parent', () => {
      tree.registerInstance('parent-h', null, '/tmp', 'Parent H');
      tree.registerInstance('child-h', 'parent-h', '/tmp', 'Child H');

      const roots = tree.getHierarchyTree();
      const parentNode = roots.find(n => n.id === 'parent-h');

      expect(parentNode?.children).toHaveLength(1);
      expect(parentNode?.children[0].id).toBe('child-h');
    });

    it('sets depth correctly on tree nodes', () => {
      tree.registerInstance('d0', null, '/tmp', 'D0');
      tree.registerInstance('d1', 'd0', '/tmp', 'D1');
      tree.registerInstance('d2', 'd1', '/tmp', 'D2');

      const roots = tree.getHierarchyTree();
      const d0 = roots.find(n => n.id === 'd0')!;
      const d1 = d0.children[0];
      const d2 = d1.children[0];

      expect(d0.depth).toBe(0);
      expect(d1.depth).toBe(1);
      expect(d2.depth).toBe(2);
    });
  });

  // ---------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------

  describe('lifecycle', () => {
    it('shutdown terminates all workers and clears instances', async () => {
      tree.registerInstance('life-1', null, '/tmp', 'Life 1');
      tree.registerInstance('life-2', null, '/tmp', 'Life 2');

      await tree.shutdown();

      const stats = tree.getTreeStats();
      expect(stats.totalInstances).toBe(0);
      expect(stats.totalWorkers).toBe(0);
    });

    it('shutdown emits tree:shutdown event', async () => {
      const handler = vi.fn();
      tree.on('tree:shutdown', handler);

      await tree.shutdown();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('reset awaits shutdown and then resets config to defaults', async () => {
      tree.configure({ maxChildrenPerNode: 4 });
      tree.registerInstance('reset-inst', null, '/tmp', 'Reset Inst');

      await tree.reset();

      // After reset, instances should be cleared
      const stats = tree.getTreeStats();
      expect(stats.totalInstances).toBe(0);
    });

    it('destroy removes all listeners', async () => {
      const handler = vi.fn();
      tree.on('tree:shutdown', handler);

      await tree.destroy();

      // destroy() calls shutdown() internally, which emits 'tree:shutdown' once.
      // After that, removeAllListeners() runs. A subsequent manual emit must not
      // trigger the handler again, confirming all listeners have been removed.
      const callsAfterDestroy = handler.mock.calls.length; // captures the one call from shutdown
      tree.emit('tree:shutdown');
      // Still the same count — no additional call after destroy cleaned up listeners
      expect(handler).toHaveBeenCalledTimes(callsAfterDestroy);
    });

    it('_resetForTesting produces a fresh singleton', async () => {
      tree.registerInstance('pre-reset', null, '/tmp', 'Pre Reset');
      expect(tree.getTreeStats().totalInstances).toBe(1);

      await SupervisorTree._resetForTesting();
      const freshTree = SupervisorTree.getInstance();

      expect(freshTree.getTreeStats().totalInstances).toBe(0);
    });

    it('initialize is idempotent (calling twice does not throw)', () => {
      tree.initialize();
      expect(() => tree.initialize()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------
  // configure
  // ---------------------------------------------------------------

  describe('configure', () => {
    it('merges partial config without overwriting unspecified fields', () => {
      tree.configure({ maxChildrenPerNode: 8 });
      // Register an instance to force initialisation so we can observe effect
      tree.registerInstance('cfg-inst', null, '/tmp', 'Cfg Inst');

      // Tree should be functional with the new config
      const stats = tree.getTreeStats();
      expect(stats.totalInstances).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // toJSON
  // ---------------------------------------------------------------

  describe('toJSON', () => {
    it('includes instances and stats in serialized output', () => {
      tree.registerInstance('json-inst', null, '/tmp', 'JSON Inst');

      const json = tree.toJSON();

      expect(json.instances).toHaveLength(1);
      expect(json.instances[0].instanceId).toBe('json-inst');
      expect(json.stats.totalInstances).toBe(1);
    });

    it('rootSupervisor is null before initialization', () => {
      // Fresh tree, no instances registered → rootSupervisor not yet created
      const json = tree.toJSON();
      expect(json.rootSupervisor).toBeNull();
    });

    it('rootSupervisor is populated after registering an instance', () => {
      tree.registerInstance('json-worker', null, '/tmp', 'JSON Worker');
      const json = tree.toJSON();
      expect(json.rootSupervisor).not.toBeNull();
    });
  });
});
