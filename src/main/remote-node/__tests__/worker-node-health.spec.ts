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
  disconnectNode: vi.fn(),
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
    mockConnection.disconnectNode.mockReset();
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
    // The socket must be closed alongside deregistration — otherwise a
    // suspended-then-resumed worker heartbeats into the void forever.
    expect(mockConnection.disconnectNode).toHaveBeenCalledWith('n4', expect.any(String));
  });

  // -------------------------------------------------------------------------
  // Coordinator freeze is not a node failure
  // -------------------------------------------------------------------------

  /**
   * Simulates the coordinator's own event loop being blocked: wall-clock time
   * moves on but no timer runs, then the overdue interval fires once. The
   * node's heartbeats are sitting unread in the socket the whole time.
   */
  function freezeCoordinator(ms: number): void {
    vi.setSystemTime(Date.now() + ms);
  }

  it('does not deregister a node because the coordinator itself was frozen', async () => {
    registry.registerNode(makeNode('frozen', { status: 'connected', lastHeartbeat: Date.now() }));
    health.startMonitoring('frozen');
    await vi.advanceTimersByTimeAsync(10_000);

    // 2026-10-28: three main-process stalls of 82-134 s each deregistered
    // windows-pc and noahlaptop together, then their queued heartbeats arrived
    // for an "unknown node" and both sockets were closed.
    freezeCoordinator(115_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(registry.getNode('frozen')).toBeDefined();
    expect(registry.getNode('frozen')?.status).toBe('connected');
    expect(mockConnection.disconnectNode).not.toHaveBeenCalled();
  });

  it('still deregisters a node that stays silent for the full window after a coordinator freeze', async () => {
    registry.registerNode(makeNode('silent', { status: 'connected', lastHeartbeat: Date.now() }));
    health.startMonitoring('silent');
    await vi.advanceTimersByTimeAsync(10_000);

    freezeCoordinator(115_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(registry.getNode('silent')).toBeDefined();

    // No heartbeat ever arrives after the coordinator resumes. Silence is
    // counted from the resume: degraded at 60 s, gone at 90 s.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(registry.getNode('silent')?.status).toBe('degraded');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(registry.getNode('silent')).toBeDefined();
    expect(mockConnection.disconnectNode).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(registry.getNode('silent')).toBeUndefined();
    expect(mockConnection.disconnectNode).toHaveBeenCalledWith('silent', expect.any(String));
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
