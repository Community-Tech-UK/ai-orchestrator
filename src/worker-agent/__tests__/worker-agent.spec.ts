import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerAgent } from '../worker-agent';
import type { WorkerConfig } from '../worker-config';

// Mock WebSocket
vi.mock('ws', () => {
  const EventEmitter = require('events').EventEmitter;
  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn((_data: string, cb?: (err?: Error) => void) => cb?.());
    close = vi.fn();
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

  beforeEach(() => {
    vi.useFakeTimers();
    agent = new WorkerAgent(mockConfig);
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
});
