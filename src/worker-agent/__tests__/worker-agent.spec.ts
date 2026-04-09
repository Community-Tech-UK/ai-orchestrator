import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WorkerConfig } from '../worker-config';

// Mock WebSocket
vi.mock('ws', () => {
  class MockWebSocket {
    static OPEN = 1;
    readyState = 1;
    private listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    send = vi.fn((_data: string, cb?: (err?: Error) => void) => cb?.());
    close = vi.fn();

    on(event: string, listener: (...args: unknown[]) => void): this {
      const handlers = this.listeners.get(event) ?? [];
      handlers.push(listener);
      this.listeners.set(event, handlers);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const handlers = this.listeners.get(event) ?? [];
      for (const handler of handlers) {
        handler(...args);
      }
      return handlers.length > 0;
    }
  }
  return { WebSocket: MockWebSocket, default: { WebSocket: MockWebSocket } };
});

// Mock capability-reporter
vi.mock('../capability-reporter', () => ({
  reportCapabilities: vi.fn(async () => ({
    platform: 'win32',
    arch: 'x64',
    cpuCores: 16,
    totalMemoryMB: 96000,
    availableMemoryMB: 64000,
    supportedClis: ['claude', 'codex'],
    hasBrowserRuntime: true,
    hasBrowserMcp: false,
    hasDocker: true,
    maxConcurrentInstances: 10,
    workingDirectories: [],
  })),
}));

class MockLocalInstanceManager extends EventEmitter {
  spawn = vi.fn(async () => undefined);
  sendInput = vi.fn(async () => undefined);
  terminate = vi.fn(async () => undefined);
  interrupt = vi.fn(async () => undefined);
  terminateAll = vi.fn(async () => undefined);
  getInstanceCount = vi.fn(() => 0);
}

let mockInstanceManager: MockLocalInstanceManager;

vi.mock('../local-instance-manager', () => ({
  LocalInstanceManager: vi.fn().mockImplementation(() => {
    mockInstanceManager = new MockLocalInstanceManager();
    return mockInstanceManager;
  }),
}));

import { WorkerAgent } from '../worker-agent';

const mockConfig: WorkerConfig = {
  nodeId: 'test-node-1',
  name: 'test-pc',
  coordinatorUrl: 'ws://localhost:4878',
  authToken: 'test-token',
  maxConcurrentInstances: 10,
  workingDirectories: ['/tmp/work'],
  reconnectIntervalMs: 1000,
  heartbeatIntervalMs: 5000,
};

describe('WorkerAgent', () => {
  let agent: WorkerAgent;
  let wsSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    agent = new WorkerAgent(mockConfig);
    wsSend = vi.fn((_data: string, cb?: (err?: Error) => void) => cb?.());
    (agent as unknown as { ws: { readyState: number; send: typeof wsSend; close: ReturnType<typeof vi.fn> } }).ws = {
      readyState: 1,
      send: wsSend,
      close: vi.fn(),
    };
  });

  afterEach(async () => {
    await agent.disconnect();
    vi.useRealTimers();
  });

  it('creates without error', () => {
    expect(agent).toBeDefined();
  });

  it('builds registration message with correct fields', () => {
    const msg = (agent as unknown as { buildRegistrationMessage: () => unknown }).buildRegistrationMessage();
    expect(msg).toMatchObject({
      jsonrpc: '2.0',
      method: 'node.register',
      params: {
        nodeId: 'test-node-1',
        name: 'test-pc',
        token: 'test-token',
      },
    });
  });

  it('maps instance.sendInput failures to INSTANCE_NOT_FOUND', async () => {
    mockInstanceManager.sendInput.mockRejectedValueOnce(new Error('Instance not found: missing'));

    await (agent as unknown as {
      handleRpcRequest: (msg: unknown) => Promise<void>;
    }).handleRpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'instance.sendInput',
      params: { instanceId: 'missing', message: 'hello' },
    });

    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.error.code).toBe(-32002);
  });

  it('maps instance.spawn failures to SPAWN_FAILED', async () => {
    mockInstanceManager.spawn.mockRejectedValueOnce(new Error('Worker at capacity (10 instances)'));

    await (agent as unknown as {
      handleRpcRequest: (msg: unknown) => Promise<void>;
    }).handleRpcRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'instance.spawn',
      params: { instanceId: 'spawn-1', cliType: 'claude', workingDirectory: '/tmp/work' },
    });

    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.error.code).toBe(-32003);
  });

  it('forwards permission requests from the local instance manager', () => {
    mockInstanceManager.emit('instance:permissionRequest', 'inst-1', {
      id: 'perm-1',
      prompt: 'Allow command?',
      timestamp: 1234,
    });

    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.permissionRequest');
    expect(payload.params).toMatchObject({
      instanceId: 'inst-1',
      permission: {
        id: 'perm-1',
        prompt: 'Allow command?',
        timestamp: 1234,
      },
      token: 'test-token',
    });
  });

  it('sends instance.output as notification (no id field)', () => {
    mockInstanceManager.emit('instance:output', 'inst-1', { type: 'assistant', content: 'hello' });

    // Advance past the 50ms batch interval to trigger flush
    vi.advanceTimersByTime(60);

    expect(wsSend).toHaveBeenCalled();
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.output');
    expect(payload.id).toBeUndefined(); // Notification — no id
    expect(payload.params).toMatchObject({
      instanceId: 'inst-1',
      message: { type: 'assistant', content: 'hello' },
      token: 'test-token',
    });
  });

  it('batches multiple output messages into instance.outputBatch', () => {
    mockInstanceManager.emit('instance:output', 'inst-1', { type: 'assistant', content: 'msg1' });
    mockInstanceManager.emit('instance:output', 'inst-1', { type: 'tool_use', content: 'msg2' });
    mockInstanceManager.emit('instance:output', 'inst-2', { type: 'assistant', content: 'msg3' });

    // Advance past the 50ms batch interval
    vi.advanceTimersByTime(60);

    expect(wsSend).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.outputBatch');
    expect(payload.id).toBeUndefined(); // Notification — no id
    expect(payload.params.items).toHaveLength(3);
    expect(payload.params.items[0]).toMatchObject({ instanceId: 'inst-1' });
    expect(payload.params.items[2]).toMatchObject({ instanceId: 'inst-2' });
  });

  it('flushes output buffer immediately when batch max size is reached', () => {
    // Send 10 messages (max batch size)
    for (let i = 0; i < 10; i++) {
      mockInstanceManager.emit('instance:output', 'inst-1', { type: 'assistant', content: `msg${i}` });
    }

    // Should flush immediately without waiting for timer
    expect(wsSend).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.outputBatch');
    expect(payload.params.items).toHaveLength(10);
  });

  it('sends instance.stateChange as RPC request (with id field)', () => {
    mockInstanceManager.emit('instance:stateChange', 'inst-1', 'processing');

    expect(wsSend).toHaveBeenCalled();
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.stateChange');
    expect(payload.id).toBeDefined(); // RPC request — has id
    expect(payload.params.state).toBe('processing');
  });
});
