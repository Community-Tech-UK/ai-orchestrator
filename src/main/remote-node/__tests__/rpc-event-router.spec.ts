import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

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
// Mock WorkerNodeHealth
// ---------------------------------------------------------------------------

const mockHealth = { startMonitoring: vi.fn(), stopMonitoring: vi.fn() };

vi.mock('../worker-node-health', () => ({
  getWorkerNodeHealth: vi.fn(() => mockHealth),
}));

// ---------------------------------------------------------------------------
// Mock auth-validator — auth is tested in its own spec
// ---------------------------------------------------------------------------

vi.mock('../auth-validator', () => ({
  validateAuthToken: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Mock rpc-schemas — schema validation is tested in its own spec.
// The router spec focuses on routing logic only.
// ---------------------------------------------------------------------------

vi.mock('../rpc-schemas', () => ({
  validateRpcParams: vi.fn(),
  RPC_PARAM_SCHEMAS: {
    'node.register': {},
    'node.heartbeat': {},
    'instance.output': {},
    'instance.stateChange': {},
    'instance.permissionRequest': {},
  },
}));

import { WorkerNodeRegistry } from '../worker-node-registry';
import { RpcEventRouter } from '../rpc-event-router';
import type { WorkerNodeCapabilities, WorkerNodeInfo } from '../../../shared/types/worker-node.types';
import type { RpcRequest } from '../worker-node-rpc';

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
    address: '192.168.1.1',
    capabilities: makeCapabilities(),
    status: 'connected',
    activeInstances: 0,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    ...overrides,
  };
}

function makeRpcRequest(method: string, params?: unknown, id: string | number = 1): RpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RpcEventRouter', () => {
  let registry: WorkerNodeRegistry;
  // Use a plain EventEmitter to simulate WorkerNodeConnectionServer
  let mockConnection: EventEmitter & { sendResponse: ReturnType<typeof vi.fn> };
  let router: RpcEventRouter;

  beforeEach(() => {
    vi.clearAllMocks();

    WorkerNodeRegistry._resetForTesting();
    registry = WorkerNodeRegistry.getInstance();

    mockConnection = Object.assign(new EventEmitter(), {
      sendResponse: vi.fn(),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router = new RpcEventRouter(mockConnection as any, registry);
    router.start();
  });

  // -------------------------------------------------------------------------
  // node:ws-connected — just logs, no crash
  // -------------------------------------------------------------------------

  it('handles node:ws-connected without throwing', () => {
    expect(() => {
      mockConnection.emit('node:ws-connected', 'node-1');
    }).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // node:ws-disconnected — stops health monitoring and deregisters
  // -------------------------------------------------------------------------

  it('stops health monitoring and deregisters node on ws-disconnected', () => {
    registry.registerNode(makeNode('node-2'));

    mockConnection.emit('node:ws-disconnected', 'node-2');

    expect(mockHealth.stopMonitoring).toHaveBeenCalledWith('node-2');
    expect(registry.getNode('node-2')).toBeUndefined();
  });

  it('stops health monitoring even when node is not in registry on ws-disconnected', () => {
    // Node was never registered — should still stop monitoring without crashing
    mockConnection.emit('node:ws-disconnected', 'unknown-node');

    expect(mockHealth.stopMonitoring).toHaveBeenCalledWith('unknown-node');
    // deregisterNode should not have been called (node not in registry)
    expect(registry.getNode('unknown-node')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // rpc:request node.register — node added to registry, health monitoring started
  // -------------------------------------------------------------------------

  it('registers node and starts health monitoring on node.register request', () => {
    const capabilities = makeCapabilities({ cpuCores: 8 });
    const request = makeRpcRequest('node.register', {
      nodeId: 'node-3',
      name: 'My Worker',
      capabilities,
    });

    mockConnection.emit('rpc:request', 'node-3', request);

    const registered = registry.getNode('node-3');
    expect(registered).toBeDefined();
    expect(registered?.name).toBe('My Worker');
    expect(registered?.capabilities.cpuCores).toBe(8);
    expect(registered?.status).toBe('connected');
    expect(registered?.activeInstances).toBe(0);

    expect(mockHealth.startMonitoring).toHaveBeenCalledWith('node-3');
    expect(mockConnection.sendResponse).toHaveBeenCalledWith(
      'node-3',
      expect.objectContaining({ result: { ok: true } }),
    );
  });

  it('falls back to WebSocket nodeId when params.nodeId is missing', () => {
    const capabilities = makeCapabilities();
    const request = makeRpcRequest('node.register', {
      name: 'Fallback Node',
      capabilities,
    });

    mockConnection.emit('rpc:request', 'ws-node-id', request);

    expect(registry.getNode('ws-node-id')).toBeDefined();
    expect(mockHealth.startMonitoring).toHaveBeenCalledWith('ws-node-id');
  });

  // -------------------------------------------------------------------------
  // rpc:request node.heartbeat — updates heartbeat, lastHeartbeat set
  // -------------------------------------------------------------------------

  it('updates heartbeat and responds ok on node.heartbeat request', () => {
    registry.registerNode(makeNode('node-4', { status: 'degraded' }));

    const newCaps = makeCapabilities({ availableMemoryMB: 7000 });
    const request = makeRpcRequest('node.heartbeat', { capabilities: newCaps, activeInstances: 3 }, 2);

    mockConnection.emit('rpc:request', 'node-4', request);

    const node = registry.getNode('node-4');
    expect(node?.capabilities.availableMemoryMB).toBe(7000);
    expect(node?.activeInstances).toBe(3);
    expect(node?.lastHeartbeat).toBeGreaterThan(0);
    // Heartbeat should restore a degraded node to connected
    expect(node?.status).toBe('connected');

    expect(mockConnection.sendResponse).toHaveBeenCalledWith(
      'node-4',
      expect.objectContaining({ result: { ok: true } }),
    );
  });

  it('returns NODE_NOT_FOUND when heartbeat arrives for an unknown node', () => {
    const request = makeRpcRequest('node.heartbeat', {
      capabilities: makeCapabilities(),
      activeInstances: 1,
    }, 22);

    mockConnection.emit('rpc:request', 'missing-node', request);

    expect(mockConnection.sendResponse).toHaveBeenCalledWith(
      'missing-node',
      expect.objectContaining({
        error: expect.objectContaining({ code: -32001 }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // rpc:request instance.output — emits remote:instance-output on registry
  // -------------------------------------------------------------------------

  it('emits remote:instance-output on registry for instance.output request', () => {
    registry.registerNode(makeNode('node-5'));
    const outputHandler = vi.fn();
    registry.on('remote:instance-output', outputHandler);

    const request = makeRpcRequest('instance.output', {
      instanceId: 'inst-1',
      message: 'hello output',
    }, 3);

    mockConnection.emit('rpc:request', 'node-5', request);

    expect(outputHandler).toHaveBeenCalledWith({
      nodeId: 'node-5',
      instanceId: 'inst-1',
      message: 'hello output',
    });
    expect(mockConnection.sendResponse).toHaveBeenCalledWith(
      'node-5',
      expect.objectContaining({ result: { ok: true } }),
    );
  });

  // -------------------------------------------------------------------------
  // rpc:request instance.stateChange — emits remote:instance-state-change
  // -------------------------------------------------------------------------

  it('emits remote:instance-state-change on registry for instance.stateChange request', () => {
    registry.registerNode(makeNode('node-6'));
    const stateHandler = vi.fn();
    registry.on('remote:instance-state-change', stateHandler);

    const request = makeRpcRequest('instance.stateChange', {
      instanceId: 'inst-2',
      state: 'idle',
      info: { reason: 'done' },
    }, 4);

    mockConnection.emit('rpc:request', 'node-6', request);

    expect(stateHandler).toHaveBeenCalledWith({
      nodeId: 'node-6',
      instanceId: 'inst-2',
      state: 'idle',
      info: { reason: 'done' },
    });
    expect(mockConnection.sendResponse).toHaveBeenCalledWith(
      'node-6',
      expect.objectContaining({ result: { ok: true } }),
    );
  });

  // -------------------------------------------------------------------------
  // rpc:request instance.permissionRequest — emits remote:instance-permission-request
  // -------------------------------------------------------------------------

  it('emits remote:instance-permission-request on registry for instance.permissionRequest request', () => {
    registry.registerNode(makeNode('node-7'));
    const permHandler = vi.fn();
    registry.on('remote:instance-permission-request', permHandler);

    const request = makeRpcRequest('instance.permissionRequest', {
      instanceId: 'inst-3',
      permission: 'file:read',
    }, 5);

    mockConnection.emit('rpc:request', 'node-7', request);

    expect(permHandler).toHaveBeenCalledWith({
      nodeId: 'node-7',
      instanceId: 'inst-3',
      permission: 'file:read',
    });
    expect(mockConnection.sendResponse).toHaveBeenCalledWith(
      'node-7',
      expect.objectContaining({ result: { ok: true } }),
    );
  });

  // -------------------------------------------------------------------------
  // rpc:notification node.heartbeat — updates heartbeat without response
  // -------------------------------------------------------------------------

  it('updates heartbeat on node.heartbeat notification (no response sent)', () => {
    registry.registerNode(makeNode('node-8'));

    const newCaps = makeCapabilities({ availableMemoryMB: 5000 });
    mockConnection.emit('rpc:notification', 'node-8', {
      jsonrpc: '2.0',
      method: 'node.heartbeat',
      params: { capabilities: newCaps, activeInstances: 2 },
    });

    expect(registry.getNode('node-8')?.capabilities.availableMemoryMB).toBe(5000);
    expect(registry.getNode('node-8')?.activeInstances).toBe(2);
    expect(mockConnection.sendResponse).not.toHaveBeenCalled();
  });

  it('returns METHOD_NOT_FOUND for unknown RPC requests', () => {
    mockConnection.emit('rpc:request', 'node-10', makeRpcRequest('node.unknown', {}, 99));

    expect(mockConnection.sendResponse).toHaveBeenCalledWith(
      'node-10',
      expect.objectContaining({
        error: expect.objectContaining({ code: -32601 }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // stop() — all listeners removed
  // -------------------------------------------------------------------------

  it('removes all event listeners after stop()', () => {
    router.stop();

    // Emit all events — none of the handlers should fire
    const disconnectSpy = vi.spyOn(registry, 'deregisterNode');
    registry.registerNode(makeNode('node-9'));

    mockConnection.emit('node:ws-disconnected', 'node-9');
    expect(disconnectSpy).not.toHaveBeenCalled();

    mockConnection.emit('node:ws-connected', 'node-9');
    // No crash expected

    const outputHandler = vi.fn();
    registry.on('remote:instance-output', outputHandler);
    mockConnection.emit('rpc:request', 'node-9', makeRpcRequest('instance.output', { instanceId: 'x', message: 'y' }));
    expect(outputHandler).not.toHaveBeenCalled();

    mockConnection.emit('rpc:notification', 'node-9', {
      jsonrpc: '2.0',
      method: 'node.heartbeat',
      params: {},
    });
    expect(mockHealth.stopMonitoring).not.toHaveBeenCalled();
  });
});
