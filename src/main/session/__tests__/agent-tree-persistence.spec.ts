import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentTreePersistence } from '../agent-tree-persistence';
import { AGENT_TREE_SCHEMA_VERSION, type AgentTreeNode, type AgentTreeSnapshot } from '../../../shared/types/agent-tree.types';

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
    expect(root.statusTimeline[0]?.status).toBe('idle');
    expect(root.role).toBe('parent_orchestrator');
	  });

  it('captures child routing runtime metadata in schema v2 snapshots', () => {
    const persistence = AgentTreePersistence.getInstance();
    const instances = [
      makeInstance('root', null, ['child-1']),
      {
        ...makeInstance('child-1', 'root', []),
        currentModel: 'gpt-5.3-codex',
        metadata: {
          orchestration: {
            role: 'worker',
            task: 'Check implementation',
            routingAudit: {
              requestedProvider: 'copilot',
              actualProvider: 'copilot',
              actualModel: 'gemini-3.1-pro-preview',
              routingSource: 'explicit',
            },
          },
        },
      },
    ];

    const snapshot = persistence.buildSnapshot('root', instances);
    const child = snapshot.nodes.find(n => n.instanceId === 'child-1')!;

    expect(snapshot.schemaVersion).toBe(AGENT_TREE_SCHEMA_VERSION);
    expect(child.role).toBe('worker');
    expect(child.spawnPromptHash).toHaveLength(64);
    expect(child.routing?.actualModel).toBe('gemini-3.1-pro-preview');
    expect(child.spawnConfig?.task).toBe('Check implementation');
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
	      schemaVersion: AGENT_TREE_SCHEMA_VERSION,
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
	      schemaVersion: AGENT_TREE_SCHEMA_VERSION,
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
	    totalTokensUsed: 100, createdAt: Date.now(), lastActivity: Date.now(),
	  };
}

function makeNode(id: string, parentId: string | null, childrenIds: string[], depth: number): AgentTreeNode {
  return {
	    instanceId: id, displayName: `Node ${id}`, parentId, childrenIds, depth,
	    status: 'idle', provider: 'claude-cli', workingDirectory: '/tmp/test',
	    sessionId: `session-${id}`, hasResult: false,
	    statusTimeline: [{ status: 'idle', timestamp: Date.now() }],
	    lastActivityAt: Date.now(),
	    createdAt: Date.now(),
	  };
	}
