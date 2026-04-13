import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger to avoid electron / filesystem dependencies
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Mock InstanceManager
// ---------------------------------------------------------------------------

interface MockInstance {
  id: string;
  status: string;
  nodeId: string;
}

const mockInstances: MockInstance[] = [];

const mockInstanceManager = {
  getInstancesByNode: vi.fn((nodeId: string) =>
    mockInstances.filter(i => i.nodeId === nodeId),
  ),
  getInstance: vi.fn((id: string) =>
    mockInstances.find(i => i.id === id),
  ),
  updateInstanceStatus: vi.fn(),
  emit: vi.fn(),
};

vi.mock('../../instance/instance-manager', () => ({
  getInstanceManager: () => mockInstanceManager,
}));

import { WorkerNodeRegistry } from '../worker-node-registry';
import { handleNodeFailover, FAILOVER_GRACE_MS } from '../node-failover';
import type { WorkerNodeInfo, WorkerNodeCapabilities } from '../../../shared/types/worker-node.types';

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
    address: `192.168.1.1`,
    capabilities: makeCapabilities(),
    status: 'connected',
    activeInstances: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleNodeFailover', () => {
  let registry: WorkerNodeRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    WorkerNodeRegistry._resetForTesting();
    registry = WorkerNodeRegistry.getInstance();

    // Reset all mock state
    mockInstances.length = 0;
    mockInstanceManager.getInstancesByNode.mockClear();
    mockInstanceManager.getInstance.mockClear();
    mockInstanceManager.updateInstanceStatus.mockClear();
    mockInstanceManager.emit.mockClear();
    mockInstanceManager.getInstancesByNode.mockImplementation((nodeId: string) =>
      mockInstances.filter(i => i.nodeId === nodeId),
    );
    mockInstanceManager.getInstance.mockImplementation((id: string) =>
      mockInstances.find(i => i.id === id),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Test 1: No-op when node has no instances
  // -------------------------------------------------------------------------

  it('does nothing when the node has no instances', () => {
    registry.registerNode(makeNode('node-1'));

    handleNodeFailover('node-1', mockInstanceManager as never);

    expect(mockInstanceManager.updateInstanceStatus).not.toHaveBeenCalled();
    expect(mockInstanceManager.emit).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2: Immediately marks instances as degraded
  // -------------------------------------------------------------------------

  it('immediately marks all affected instances as degraded', () => {
    registry.registerNode(makeNode('node-2'));
    mockInstances.push(
      { id: 'inst-a', status: 'idle', nodeId: 'node-2' },
      { id: 'inst-b', status: 'busy', nodeId: 'node-2' },
    );

    handleNodeFailover('node-2', mockInstanceManager as never);

    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledTimes(2);
    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledWith(
      'inst-a',
      'degraded',
      { reason: 'worker-node-disconnected', nodeId: 'node-2' },
    );
    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledWith(
      'inst-b',
      'degraded',
      { reason: 'worker-node-disconnected', nodeId: 'node-2' },
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: After grace period, marks instances as failed and emits events
  // -------------------------------------------------------------------------

  it('marks instances as failed and emits instance:remote-lost after grace period', () => {
    // Node is not in the registry — simulates a node that has already been
    // deregistered by the health monitor before failover was triggered.
    mockInstances.push(
      { id: 'inst-c', status: 'idle', nodeId: 'node-3' },
      { id: 'inst-d', status: 'busy', nodeId: 'node-3' },
    );

    handleNodeFailover('node-3', mockInstanceManager as never);

    // Clear the degraded calls so we can check failed calls separately
    mockInstanceManager.updateInstanceStatus.mockClear();
    mockInstanceManager.emit.mockClear();

    // Advance past the grace period (30s + 1s buffer)
    vi.advanceTimersByTime(FAILOVER_GRACE_MS + 1_000);

    // Both instances should now be marked failed
    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledTimes(2);
    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledWith(
      'inst-c',
      'failed',
      { reason: 'worker-node-disconnected', nodeId: 'node-3' },
    );
    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledWith(
      'inst-d',
      'failed',
      { reason: 'worker-node-disconnected', nodeId: 'node-3' },
    );

    // instance:remote-lost should be emitted for each instance
    expect(mockInstanceManager.emit).toHaveBeenCalledTimes(2);
    expect(mockInstanceManager.emit).toHaveBeenCalledWith('instance:remote-lost', {
      instanceId: 'inst-c',
      nodeId: 'node-3',
    });
    expect(mockInstanceManager.emit).toHaveBeenCalledWith('instance:remote-lost', {
      instanceId: 'inst-d',
      nodeId: 'node-3',
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: Reconnect during grace period cancels failover and restores status
  // -------------------------------------------------------------------------

  it('cancels failover and restores original statuses when node reconnects during grace period', () => {
    mockInstances.push(
      { id: 'inst-e', status: 'idle', nodeId: 'node-4' },
      { id: 'inst-f', status: 'busy', nodeId: 'node-4' },
    );

    handleNodeFailover('node-4', mockInstanceManager as never);

    // Clear immediate degraded calls
    mockInstanceManager.updateInstanceStatus.mockClear();

    // Simulate node reconnecting before grace period expires
    // registerNode emits 'node:connected' which the failover handler listens to
    registry.registerNode(makeNode('node-4', { status: 'connected' }));

    // The failover should have restored original statuses
    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledTimes(2);
    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledWith('inst-e', 'idle', expect.any(Object));
    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledWith('inst-f', 'busy', expect.any(Object));

    // Advance well past the grace period — no further failed calls or emit
    mockInstanceManager.updateInstanceStatus.mockClear();
    mockInstanceManager.emit.mockClear();
    vi.advanceTimersByTime(FAILOVER_GRACE_MS + 5_000);

    expect(mockInstanceManager.updateInstanceStatus).not.toHaveBeenCalled();
    expect(mockInstanceManager.emit).not.toHaveBeenCalled();
  });
});
