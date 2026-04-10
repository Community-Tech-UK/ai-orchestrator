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

const mockConnection = {
  sendRpc: vi.fn(),
};

vi.mock('../worker-node-connection', () => ({
  getWorkerNodeConnectionServer: () => mockConnection,
}));

import { WorkerNodeRegistry } from '../worker-node-registry';
import { WorkerNodeHealth } from '../worker-node-health';
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
    address: `192.168.1.${id}`,
    capabilities: makeCapabilities(),
    status: 'connected',
    activeInstances: 0,
    lastHeartbeat: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerNodeHealth', () => {
  let registry: WorkerNodeRegistry;
  let health: WorkerNodeHealth;

  beforeEach(() => {
    vi.useFakeTimers();
    mockConnection.sendRpc.mockReset();
    mockConnection.sendRpc.mockResolvedValue({ pong: Date.now() });
    WorkerNodeRegistry._resetForTesting();
    WorkerNodeHealth._resetForTesting();
    registry = WorkerNodeRegistry.getInstance();
    health = WorkerNodeHealth.getInstance();
  });

  afterEach(() => {
    health.stopAll();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // startMonitoring / isMonitoring
  // -------------------------------------------------------------------------

  it('startMonitoring → isMonitoring returns true', () => {
    registry.registerNode(makeNode('n1'));
    health.startMonitoring('n1');
    expect(health.isMonitoring('n1')).toBe(true);
  });

  it('records latency from node pings while monitoring', async () => {
    registry.registerNode(makeNode('n1-latency'));
    health.startMonitoring('n1-latency');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockConnection.sendRpc).toHaveBeenCalledWith('n1-latency', 'node.ping');
    expect(registry.getNode('n1-latency')?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // stopMonitoring
  // -------------------------------------------------------------------------

  it('stopMonitoring → isMonitoring returns false', () => {
    registry.registerNode(makeNode('n2'));
    health.startMonitoring('n2');
    health.stopMonitoring('n2');
    expect(health.isMonitoring('n2')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Degraded after 65s without heartbeat
  // -------------------------------------------------------------------------

  it('marks node as degraded after 65s without a heartbeat', () => {
    // Register node with a heartbeat set to now
    const node = makeNode('n3', { status: 'connected', lastHeartbeat: Date.now() });
    registry.registerNode(node);
    health.startMonitoring('n3');

    // Advance 65 seconds — past DEGRADED_THRESHOLD_MS (60s) but below DISCONNECT_THRESHOLD_MS (90s)
    vi.advanceTimersByTime(65_000);

    expect(registry.getNode('n3')?.status).toBe('degraded');
  });

  // -------------------------------------------------------------------------
  // Deregistered after 95s without heartbeat
  // -------------------------------------------------------------------------

  it('deregisters node after 95s without a heartbeat', () => {
    const node = makeNode('n4', { status: 'connected', lastHeartbeat: Date.now() });
    registry.registerNode(node);
    health.startMonitoring('n4');

    // Advance 95 seconds — past DISCONNECT_THRESHOLD_MS (90s)
    vi.advanceTimersByTime(95_000);

    expect(registry.getNode('n4')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Node stays connected when heartbeats arrive on time
  // -------------------------------------------------------------------------

  it('node stays connected when heartbeats arrive on time', () => {
    const node = makeNode('n5', { status: 'connected', lastHeartbeat: Date.now() });
    registry.registerNode(node);
    health.startMonitoring('n5');

    // Advance 40s, send heartbeat, advance another 40s — never exceeds DEGRADED_THRESHOLD_MS (60s)
    vi.advanceTimersByTime(40_000);
    registry.updateHeartbeat('n5', makeCapabilities());

    vi.advanceTimersByTime(40_000);
    registry.updateHeartbeat('n5', makeCapabilities());

    vi.advanceTimersByTime(40_000);

    expect(registry.getNode('n5')?.status).toBe('connected');
  });

  // -------------------------------------------------------------------------
  // stopMonitoring stops intervals (node not deregistered after long advance)
  // -------------------------------------------------------------------------

  it('stopMonitoring prevents further health checks', () => {
    const node = makeNode('n6', { status: 'connected', lastHeartbeat: Date.now() });
    registry.registerNode(node);
    health.startMonitoring('n6');
    health.stopMonitoring('n6');

    // Advance well past disconnect threshold (90s) — monitoring is stopped so node should persist
    vi.advanceTimersByTime(100_000);

    // Node should still be in registry (monitoring was stopped before any check ran)
    expect(registry.getNode('n6')).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // stopAll stops all monitored nodes
  // -------------------------------------------------------------------------

  it('stopAll stops monitoring all nodes', () => {
    registry.registerNode(makeNode('a1'));
    registry.registerNode(makeNode('a2'));
    health.startMonitoring('a1');
    health.startMonitoring('a2');

    health.stopAll();

    expect(health.isMonitoring('a1')).toBe(false);
    expect(health.isMonitoring('a2')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Auto-stop when node not found in registry
  // -------------------------------------------------------------------------

  it('stops monitoring automatically if node is removed from registry', () => {
    registry.registerNode(makeNode('n7'));
    health.startMonitoring('n7');

    // Manually remove node from registry (e.g., external deregistration)
    registry.deregisterNode('n7');

    // Advance to trigger a check — monitor should detect missing node and stop itself
    vi.advanceTimersByTime(10_000);

    expect(health.isMonitoring('n7')).toBe(false);
  });
});
