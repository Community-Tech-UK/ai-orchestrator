import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the logger to avoid electron / filesystem dependencies
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { WorkerNodeRegistry } from '../worker-node-registry';
import type { WorkerNodeInfo, WorkerNodeCapabilities, NodePlacementPrefs } from '../../../shared/types/worker-node.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapabilities(overrides: Partial<WorkerNodeCapabilities> = {}): WorkerNodeCapabilities {
  return {
    platform: 'linux',
    arch: 'x64',
    cpuCores: 4,
    totalMemoryMB: 8192,
    availableMemoryMB: 4096,
    supportedClis: ['claude'],
    hasBrowserRuntime: false,
    hasBrowserMcp: false,
    hasDocker: false,
    maxConcurrentInstances: 4,
    workingDirectories: ['/workspace'],
    ...overrides,
  };
}

function makeNode(id: string, overrides: Partial<WorkerNodeInfo> = {}): WorkerNodeInfo {
  return {
    id,
    name: `node-${id}`,
    address: `192.168.1.${id}`,
    capabilities: makeCapabilities(),
    status: 'connected',
    activeInstances: 0,
    latencyMs: 20,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerNodeRegistry', () => {
  let registry: WorkerNodeRegistry;

  beforeEach(() => {
    WorkerNodeRegistry._resetForTesting();
    registry = WorkerNodeRegistry.getInstance();
  });

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  describe('registerNode', () => {
    it('stores the node and makes it retrievable via getNode', () => {
      const node = makeNode('1');
      registry.registerNode(node);
      expect(registry.getNode('1')).toEqual(node);
    });

    it('emits node:connected when a node is registered', () => {
      const node = makeNode('2');
      const handler = vi.fn();
      registry.on('node:connected', handler);
      registry.registerNode(node);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(node);
    });

    it('overwrites an existing node when re-registered with the same id', () => {
      const node1 = makeNode('3', { name: 'first' });
      const node2 = makeNode('3', { name: 'second' });
      registry.registerNode(node1);
      registry.registerNode(node2);
      expect(registry.getNode('3')?.name).toBe('second');
    });
  });

  describe('deregisterNode', () => {
    it('removes the node so getNode returns undefined', () => {
      registry.registerNode(makeNode('4'));
      registry.deregisterNode('4');
      expect(registry.getNode('4')).toBeUndefined();
    });

    it('emits node:disconnected when a registered node is removed', () => {
      const node = makeNode('5');
      registry.registerNode(node);
      const handler = vi.fn();
      registry.on('node:disconnected', handler);
      registry.deregisterNode('5');
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(node);
    });

    it('does nothing for an unknown nodeId', () => {
      const handler = vi.fn();
      registry.on('node:disconnected', handler);
      registry.deregisterNode('nonexistent');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('getAllNodes', () => {
    it('returns all registered nodes', () => {
      registry.registerNode(makeNode('a'));
      registry.registerNode(makeNode('b'));
      registry.registerNode(makeNode('c'));
      expect(registry.getAllNodes()).toHaveLength(3);
    });

    it('returns an empty array when no nodes are registered', () => {
      expect(registry.getAllNodes()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getHealthyNodes
  // -------------------------------------------------------------------------

  describe('getHealthyNodes', () => {
    it('returns only nodes with status === connected', () => {
      registry.registerNode(makeNode('h1', { status: 'connected' }));
      registry.registerNode(makeNode('h2', { status: 'degraded' }));
      registry.registerNode(makeNode('h3', { status: 'disconnected' }));
      registry.registerNode(makeNode('h4', { status: 'connecting' }));

      const healthy = registry.getHealthyNodes();
      expect(healthy).toHaveLength(1);
      expect(healthy[0].id).toBe('h1');
    });

    it('returns an empty array when no nodes are healthy', () => {
      registry.registerNode(makeNode('h5', { status: 'degraded' }));
      expect(registry.getHealthyNodes()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // updateNodeMetrics
  // -------------------------------------------------------------------------

  describe('updateNodeMetrics', () => {
    it('applies partial updates to an existing node', () => {
      registry.registerNode(makeNode('m1', { activeInstances: 0 }));
      registry.updateNodeMetrics('m1', { activeInstances: 3, latencyMs: 55 });
      const updated = registry.getNode('m1');
      expect(updated?.activeInstances).toBe(3);
      expect(updated?.latencyMs).toBe(55);
    });

    it('emits node:updated after a successful update', () => {
      registry.registerNode(makeNode('m2'));
      const handler = vi.fn();
      registry.on('node:updated', handler);
      registry.updateNodeMetrics('m2', { activeInstances: 1 });
      expect(handler).toHaveBeenCalledOnce();
    });

    it('is a no-op for an unknown nodeId', () => {
      // Should not throw, and should not emit
      const handler = vi.fn();
      registry.on('node:updated', handler);
      registry.updateNodeMetrics('no-such-node', { activeInstances: 1 });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // updateHeartbeat
  // -------------------------------------------------------------------------

  describe('updateHeartbeat', () => {
    it('updates capabilities and lastHeartbeat timestamp', () => {
      const before = Date.now();
      registry.registerNode(makeNode('hb1'));
      const newCaps = makeCapabilities({ cpuCores: 8, availableMemoryMB: 6000 });
      registry.updateHeartbeat('hb1', newCaps);
      const node = registry.getNode('hb1')!;
      expect(node.capabilities.cpuCores).toBe(8);
      expect(node.capabilities.availableMemoryMB).toBe(6000);
      expect(node.lastHeartbeat).toBeGreaterThanOrEqual(before);
    });

    it('restores a degraded node to connected status', () => {
      registry.registerNode(makeNode('hb2', { status: 'degraded' }));
      registry.updateHeartbeat('hb2', makeCapabilities());
      expect(registry.getNode('hb2')?.status).toBe('connected');
    });

    it('does not change status when node is already connected', () => {
      registry.registerNode(makeNode('hb3', { status: 'connected' }));
      registry.updateHeartbeat('hb3', makeCapabilities());
      expect(registry.getNode('hb3')?.status).toBe('connected');
    });

    it('restores a disconnected node to connected status', () => {
      registry.registerNode(makeNode('hb4', { status: 'disconnected' }));
      registry.updateHeartbeat('hb4', makeCapabilities());
      // A heartbeat from any non-connected node indicates it is reachable again
      expect(registry.getNode('hb4')?.status).toBe('connected');
    });
  });

  // -------------------------------------------------------------------------
  // selectNode
  // -------------------------------------------------------------------------

  describe('selectNode', () => {
    const noPrefs: NodePlacementPrefs = {};

    it('returns null when no nodes are registered', () => {
      expect(registry.selectNode(noPrefs)).toBeNull();
    });

    it('returns null when no nodes are healthy (connected)', () => {
      registry.registerNode(makeNode('s1', { status: 'degraded' }));
      registry.registerNode(makeNode('s2', { status: 'disconnected' }));
      expect(registry.selectNode(noPrefs)).toBeNull();
    });

    it('selects the single available healthy node', () => {
      registry.registerNode(makeNode('s3'));
      expect(registry.selectNode(noPrefs)?.id).toBe('s3');
    });

    it('prefers node with more available memory', () => {
      registry.registerNode(makeNode('low-mem', {
        capabilities: makeCapabilities({ availableMemoryMB: 1024, totalMemoryMB: 8192 }),
      }));
      registry.registerNode(makeNode('high-mem', {
        capabilities: makeCapabilities({ availableMemoryMB: 7000, totalMemoryMB: 8192 }),
      }));
      expect(registry.selectNode(noPrefs)?.id).toBe('high-mem');
    });

    it('excludes nodes at max capacity', () => {
      registry.registerNode(makeNode('full', {
        activeInstances: 4,
        capabilities: makeCapabilities({ maxConcurrentInstances: 4 }),
      }));
      registry.registerNode(makeNode('available', {
        activeInstances: 0,
        capabilities: makeCapabilities({ maxConcurrentInstances: 4 }),
      }));
      expect(registry.selectNode(noPrefs)?.id).toBe('available');
    });

    it('returns null when all healthy nodes are at max capacity', () => {
      registry.registerNode(makeNode('full', {
        activeInstances: 4,
        capabilities: makeCapabilities({ maxConcurrentInstances: 4 }),
      }));
      expect(registry.selectNode(noPrefs)).toBeNull();
    });

    it('filters out nodes lacking browser runtime when requiresBrowser is true', () => {
      registry.registerNode(makeNode('no-browser', {
        capabilities: makeCapabilities({ hasBrowserRuntime: false }),
      }));
      registry.registerNode(makeNode('has-browser', {
        capabilities: makeCapabilities({ hasBrowserRuntime: true }),
      }));
      const prefs: NodePlacementPrefs = { requiresBrowser: true };
      expect(registry.selectNode(prefs)?.id).toBe('has-browser');
    });

    it('returns null when requiresBrowser=true but no node has browser runtime', () => {
      registry.registerNode(makeNode('no-browser', {
        capabilities: makeCapabilities({ hasBrowserRuntime: false }),
      }));
      expect(registry.selectNode({ requiresBrowser: true })).toBeNull();
    });

    it('filters out nodes lacking GPU when requiresGpu is true', () => {
      registry.registerNode(makeNode('no-gpu', {
        capabilities: makeCapabilities({ gpuName: undefined }),
      }));
      registry.registerNode(makeNode('has-gpu', {
        capabilities: makeCapabilities({ gpuName: 'NVIDIA RTX 4090' }),
      }));
      const prefs: NodePlacementPrefs = { requiresGpu: true };
      expect(registry.selectNode(prefs)?.id).toBe('has-gpu');
    });

    it('filters out nodes not supporting the required CLI', () => {
      registry.registerNode(makeNode('no-gemini', {
        capabilities: makeCapabilities({ supportedClis: ['claude'] }),
      }));
      registry.registerNode(makeNode('has-gemini', {
        capabilities: makeCapabilities({ supportedClis: ['claude', 'gemini'] }),
      }));
      const prefs: NodePlacementPrefs = { requiresCli: 'gemini' };
      expect(registry.selectNode(prefs)?.id).toBe('has-gemini');
    });

    it('hard-penalizes missing working directory (score drops below zero)', () => {
      // Both nodes are healthy but neither has the required working directory
      registry.registerNode(makeNode('no-dir', {
        capabilities: makeCapabilities({ workingDirectories: ['/other'] }),
      }));
      // Should return null because the penalty drops the score below zero
      const prefs: NodePlacementPrefs = { requiresWorkingDirectory: '/special' };
      expect(registry.selectNode(prefs)).toBeNull();
    });

    it('selects node that has the required working directory', () => {
      registry.registerNode(makeNode('no-dir', {
        capabilities: makeCapabilities({ workingDirectories: ['/other'] }),
      }));
      registry.registerNode(makeNode('has-dir', {
        capabilities: makeCapabilities({ workingDirectories: ['/special', '/workspace'] }),
      }));
      const prefs: NodePlacementPrefs = { requiresWorkingDirectory: '/special' };
      expect(registry.selectNode(prefs)?.id).toBe('has-dir');
    });

    it('gives a large boost to the preferred node ID', () => {
      // Two otherwise equal nodes; prefer-node boost should win
      registry.registerNode(makeNode('node-a'));
      registry.registerNode(makeNode('node-b'));
      const prefs: NodePlacementPrefs = { preferNodeId: 'node-b' };
      expect(registry.selectNode(prefs)?.id).toBe('node-b');
    });

    it('boosts nodes matching the preferred platform', () => {
      registry.registerNode(makeNode('darwin-node', {
        capabilities: makeCapabilities({ platform: 'darwin' }),
      }));
      registry.registerNode(makeNode('linux-node', {
        capabilities: makeCapabilities({ platform: 'linux' }),
      }));
      const prefs: NodePlacementPrefs = { preferPlatform: 'darwin' };
      expect(registry.selectNode(prefs)?.id).toBe('darwin-node');
    });

    it('prefers node with fewer active instances when otherwise equal', () => {
      registry.registerNode(makeNode('busy', {
        activeInstances: 3,
        capabilities: makeCapabilities({ maxConcurrentInstances: 4 }),
      }));
      registry.registerNode(makeNode('idle', {
        activeInstances: 0,
        capabilities: makeCapabilities({ maxConcurrentInstances: 4 }),
      }));
      expect(registry.selectNode(noPrefs)?.id).toBe('idle');
    });

    it('returns null when no candidate has a positive score', () => {
      // Node with requiresWorkingDirectory penalty will have a negative score
      registry.registerNode(makeNode('bad', {
        capabilities: makeCapabilities({ workingDirectories: [] }),
      }));
      const prefs: NodePlacementPrefs = { requiresWorkingDirectory: '/required' };
      expect(registry.selectNode(prefs)).toBeNull();
    });
  });
});
