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
import { handleNodeFailover, FAILOVER_GRACE_MS, FAILOVER_HARD_FAIL_MS } from '../node-failover';
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
    hasAndroidMcp: false,
    hasDocker: false,
    maxConcurrentInstances: 4,
    workingDirectories: ['/workspace'],
    browsableRoots: [],
    discoveredProjects: [],
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

  it('does not degrade instances already in a terminal failed state', () => {
    registry.registerNode(makeNode('node-2b'));
    mockInstances.push(
      { id: 'inst-active', status: 'idle', nodeId: 'node-2b' },
      { id: 'inst-failed', status: 'failed', nodeId: 'node-2b' },
    );

    handleNodeFailover('node-2b', mockInstanceManager as never);

    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledTimes(1);
    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledWith(
      'inst-active',
      'degraded',
      { reason: 'worker-node-disconnected', nodeId: 'node-2b' },
    );
    expect(mockInstanceManager.updateInstanceStatus).not.toHaveBeenCalledWith(
      'inst-failed',
      'degraded',
      expect.any(Object),
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: After the grace period, instances are RETAINED as recoverable
  // (degraded) — not failed — and a recoverable loss is announced.
  // -------------------------------------------------------------------------

  it('retains instances as recoverable after the grace period (does not fail them)', () => {
    // Node is not in the registry — simulates a node that has already been
    // deregistered by the health monitor before failover was triggered.
    mockInstances.push(
      { id: 'inst-c', status: 'idle', nodeId: 'node-3' },
      { id: 'inst-d', status: 'busy', nodeId: 'node-3' },
    );

    handleNodeFailover('node-3', mockInstanceManager as never);

    // Clear the immediate degrade calls so we can check the grace-expiry effect.
    mockInstanceManager.updateInstanceStatus.mockClear();
    mockInstanceManager.emit.mockClear();

    // Advance past the grace period (30s + 1s buffer) but NOT the hard timeout.
    vi.advanceTimersByTime(FAILOVER_GRACE_MS + 1_000);

    // Instances must NOT be failed — their work is likely still running locally.
    expect(mockInstanceManager.updateInstanceStatus).not.toHaveBeenCalled();

    // A recoverable loss is announced for each instance.
    expect(mockInstanceManager.emit).toHaveBeenCalledTimes(2);
    expect(mockInstanceManager.emit).toHaveBeenCalledWith('instance:remote-lost', {
      instanceId: 'inst-c',
      nodeId: 'node-3',
      recoverable: true,
    });
    expect(mockInstanceManager.emit).toHaveBeenCalledWith('instance:remote-lost', {
      instanceId: 'inst-d',
      nodeId: 'node-3',
      recoverable: true,
    });
  });

  // -------------------------------------------------------------------------
  // Test 3b: Only after the hard timeout are instances finally failed.
  // -------------------------------------------------------------------------

  it('marks instances failed only after the hard timeout expires', () => {
    mockInstances.push(
      { id: 'inst-h1', status: 'idle', nodeId: 'node-3h' },
      { id: 'inst-h2', status: 'busy', nodeId: 'node-3h' },
    );

    handleNodeFailover('node-3h', mockInstanceManager as never);

    // Move past grace (recoverable announced) but before hard timeout.
    vi.advanceTimersByTime(FAILOVER_GRACE_MS + 1_000);
    mockInstanceManager.updateInstanceStatus.mockClear();
    mockInstanceManager.emit.mockClear();

    // Still not failed midway through the recoverable window.
    vi.advanceTimersByTime(FAILOVER_HARD_FAIL_MS / 2);
    expect(mockInstanceManager.updateInstanceStatus).not.toHaveBeenCalled();

    // Cross the hard timeout — now they are given up.
    vi.advanceTimersByTime(FAILOVER_HARD_FAIL_MS);

    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledTimes(2);
    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledWith(
      'inst-h1',
      'failed',
      { reason: 'worker-node-hard-timeout', nodeId: 'node-3h' },
    );
    expect(mockInstanceManager.emit).toHaveBeenCalledWith('instance:remote-lost', {
      instanceId: 'inst-h1',
      nodeId: 'node-3h',
      recoverable: false,
    });
    expect(mockInstanceManager.emit).toHaveBeenCalledWith('instance:remote-lost', {
      instanceId: 'inst-h2',
      nodeId: 'node-3h',
      recoverable: false,
    });
  });

  // -------------------------------------------------------------------------
  // Test 3c: Reconnect AFTER the grace period (but before hard timeout) still
  // reconciles instances instead of failing them.
  // -------------------------------------------------------------------------

  it('reconciles instances when the node reconnects after grace but before hard timeout', () => {
    mockInstances.push(
      { id: 'inst-r1', status: 'busy', nodeId: 'node-3r' },
    );

    handleNodeFailover('node-3r', mockInstanceManager as never);
    vi.advanceTimersByTime(FAILOVER_GRACE_MS + 1_000);
    mockInstanceManager.updateInstanceStatus.mockClear();
    mockInstanceManager.emit.mockClear();

    // Node comes back within the recoverable window.
    registry.registerNode(makeNode('node-3r', { status: 'connected' }));

    expect(mockInstanceManager.updateInstanceStatus).toHaveBeenCalledWith(
      'inst-r1',
      'busy',
      expect.any(Object),
    );

    // No later failure once reconciled.
    mockInstanceManager.updateInstanceStatus.mockClear();
    mockInstanceManager.emit.mockClear();
    vi.advanceTimersByTime(FAILOVER_HARD_FAIL_MS + 5_000);
    expect(mockInstanceManager.updateInstanceStatus).not.toHaveBeenCalled();
    expect(mockInstanceManager.emit).not.toHaveBeenCalled();
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
