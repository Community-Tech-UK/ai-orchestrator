import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentTreePersistence } from '../agent-tree-persistence';
import type { AgentTreeNode, AgentTreeSnapshot } from '../../../shared/types/agent-tree.types';

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => `/tmp/test-orchestrator-${key}`,
  },
}));

describe('AgentTreePersistence', () => {
  beforeEach(() => {
    AgentTreePersistence._resetForTesting();
  });

  it('should be a singleton', () => {
    const a = AgentTreePersistence.getInstance();
    const b = AgentTreePersistence.getInstance();
    expect(a).toBe(b);
  });

  it('should build a tree snapshot from flat instance data', () => {
    const persistence = AgentTreePersistence.getInstance();
    const instances = [
      makeInstance('root', null, ['child-1', 'child-2']),
      makeInstance('child-1', 'root', []),
      makeInstance('child-2', 'root', ['grandchild-1']),
      makeInstance('grandchild-1', 'child-2', []),
    ];

    const snapshot = persistence.buildSnapshot('root', instances);
    expect(snapshot.rootId).toBe('root');
    expect(snapshot.nodes).toHaveLength(4);
    expect(snapshot.edges).toHaveLength(3);
    expect(snapshot.totalInstances).toBe(4);

    const root = snapshot.nodes.find(n => n.instanceId === 'root')!;
    expect(root.parentId).toBeNull();
    expect(root.depth).toBe(0);

    const grandchild = snapshot.nodes.find(n => n.instanceId === 'grandchild-1')!;
    expect(grandchild.depth).toBe(2);
  });

  it('should compute BFS traversal order for restore', () => {
    const persistence = AgentTreePersistence.getInstance();
    const snapshot: AgentTreeSnapshot = {
      id: 'snap-1',
      rootId: 'root',
      nodes: [
        makeNode('root', null, ['a', 'b'], 0),
        makeNode('a', 'root', ['c'], 1),
        makeNode('b', 'root', [], 1),
        makeNode('c', 'a', [], 2),
      ],
      edges: [],
      schemaVersion: 1,
      timestamp: Date.now(),
      workingDirectory: '/tmp',
      totalInstances: 4,
      totalTokensUsed: 0,
    };

    const order = persistence.computeRestoreOrder(snapshot);
    expect(order.map(n => n.instanceId)).toEqual(['root', 'a', 'b', 'c']);
  });

  it('should respect maxDepth in restore order', () => {
    const persistence = AgentTreePersistence.getInstance();
    const snapshot: AgentTreeSnapshot = {
      id: 'snap-2',
      rootId: 'root',
      nodes: [
        makeNode('root', null, ['a'], 0),
        makeNode('a', 'root', ['b'], 1),
        makeNode('b', 'a', [], 2),
      ],
      edges: [],
      schemaVersion: 1,
      timestamp: Date.now(),
      workingDirectory: '/tmp',
      totalInstances: 3,
      totalTokensUsed: 0,
    };

    const order = persistence.computeRestoreOrder(snapshot, 1);
    expect(order.map(n => n.instanceId)).toEqual(['root', 'a']);
  });
});

function makeInstance(id: string, parentId: string | null, childrenIds: string[]) {
  return {
    id, displayName: `Instance ${id}`, parentId, childrenIds,
    depth: parentId ? 1 : 0, status: 'idle', provider: 'claude-cli',
    workingDirectory: '/tmp/test', sessionId: `session-${id}`,
    totalTokensUsed: 100, createdAt: Date.now(),
  };
}

function makeNode(id: string, parentId: string | null, childrenIds: string[], depth: number): AgentTreeNode {
  return {
    instanceId: id, displayName: `Node ${id}`, parentId, childrenIds, depth,
    status: 'idle', provider: 'claude-cli', workingDirectory: '/tmp/test',
    sessionId: `session-${id}`, hasResult: false, createdAt: Date.now(),
  };
}
