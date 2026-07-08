import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockRegistry = new EventEmitter();

vi.mock('../../../remote-node/worker-node-registry', () => ({
  getWorkerNodeRegistry: () => mockRegistry,
}));

import { RemoteLocalModelAdapter } from '../remote-local-model-adapter';
import type { WorkerNodeConnectionServer } from '../../../remote-node/worker-node-connection';
import type { FileAttachment } from '../../../../shared/types/instance.types';
import type { ModelRuntimeTarget } from '../../../../shared/types/local-model-runtime.types';
import type { UnifiedSpawnOptions } from '../adapter-factory';

const TARGET_NODE_ID = 'node-worker-1';
const REMOTE_SESSION_ID = 'local-model-session-1';
const TARGET: Extract<ModelRuntimeTarget, { kind: 'local-model' }> = {
  kind: 'local-model',
  source: 'worker-node',
  selectorId: 'lm://worker-node/node-worker-1/openai-compatible/openai-compatible/qwen',
  nodeId: TARGET_NODE_ID,
  endpointProvider: 'openai-compatible',
  endpointId: 'openai-compatible',
  modelId: 'qwen2.5-coder-14b',
};
const SPAWN_OPTIONS: UnifiedSpawnOptions = {
  sessionId: REMOTE_SESSION_ID,
  workingDirectory: '/tmp/work',
  systemPrompt: 'Be helpful',
  model: 'qwen2.5-coder-14b',
};

function createMockConnection() {
  return {
    sendRpc: vi.fn(),
    sendNotification: vi.fn(),
    isNodeConnected: vi.fn().mockReturnValue(true),
  } as unknown as WorkerNodeConnectionServer;
}

describe('RemoteLocalModelAdapter', () => {
  let connection: WorkerNodeConnectionServer;
  let adapter: RemoteLocalModelAdapter;

  beforeEach(() => {
    mockRegistry.removeAllListeners();
    connection = createMockConnection();
    adapter = new RemoteLocalModelAdapter(connection, TARGET_NODE_ID, TARGET, SPAWN_OPTIONS);
  });

  it('starts a worker local-model session via RPC', async () => {
    (connection.sendRpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: REMOTE_SESSION_ID,
    });
    const spawned = vi.fn();
    adapter.on('spawned', spawned);

    await adapter.spawn();

    expect(connection.sendRpc).toHaveBeenCalledWith(TARGET_NODE_ID, 'localModel.session.start', {
      sessionId: REMOTE_SESSION_ID,
      endpointProvider: 'openai-compatible',
      endpointId: 'openai-compatible',
      modelId: 'qwen2.5-coder-14b',
      workingDirectory: '/tmp/work',
      systemPrompt: 'Be helpful',
    });
    expect(adapter.getRemoteSessionId()).toBe(REMOTE_SESSION_ID);
    expect(adapter.isRunning()).toBe(true);
    expect(spawned).toHaveBeenCalledWith(-1);
  });

  it('sends input through localModel.session.sendInput after spawn', async () => {
    (connection.sendRpc as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ sessionId: REMOTE_SESSION_ID })
      .mockResolvedValueOnce(undefined);

    await adapter.spawn();
    await adapter.sendInput('Summarize this');

    expect(connection.sendRpc).toHaveBeenNthCalledWith(2, TARGET_NODE_ID, 'localModel.session.sendInput', {
      sessionId: REMOTE_SESSION_ID,
      message: 'Summarize this',
      attachments: undefined,
    }, 0);
  });

  it('rejects attachments before forwarding remote local-model input', async () => {
    (connection.sendRpc as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ sessionId: REMOTE_SESSION_ID });
    const attachments: FileAttachment[] = [
      { name: 'file.txt', type: 'text/plain', size: 5, data: 'aGVsbG8=' },
    ];

    await adapter.spawn();
    await expect(adapter.sendInput('Summarize this', attachments)).rejects.toThrow(
      'Remote local model does not currently support attachments in orchestrator mode.',
    );

    expect(connection.sendRpc).toHaveBeenCalledTimes(1);
  });

  it('terminates the worker local-model session', async () => {
    (connection.sendRpc as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ sessionId: REMOTE_SESSION_ID })
      .mockResolvedValueOnce(undefined);

    await adapter.spawn();
    await adapter.terminate();

    expect(connection.sendRpc).toHaveBeenNthCalledWith(2, TARGET_NODE_ID, 'localModel.session.terminate', {
      sessionId: REMOTE_SESSION_ID,
    });
    expect(adapter.isRunning()).toBe(false);
  });

  it('forwards registry events for the selected remote session', async () => {
    (connection.sendRpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: REMOTE_SESSION_ID,
    });
    const outputHandler = vi.fn();
    const statusHandler = vi.fn();
    const completeHandler = vi.fn();
    adapter.on('output', outputHandler);
    adapter.on('status', statusHandler);
    adapter.on('complete', completeHandler);

    await adapter.spawn();
    const message = { id: 'm1', timestamp: 1, type: 'assistant', content: 'remote local text' };
    const response = { id: 'r1', role: 'assistant', content: 'done' };

    mockRegistry.emit('remote:instance-output', {
      nodeId: TARGET_NODE_ID,
      instanceId: REMOTE_SESSION_ID,
      message,
    });
    mockRegistry.emit('remote:instance-state-change', {
      nodeId: TARGET_NODE_ID,
      instanceId: REMOTE_SESSION_ID,
      state: 'busy',
    });
    mockRegistry.emit('remote:instance-complete', {
      nodeId: TARGET_NODE_ID,
      instanceId: REMOTE_SESSION_ID,
      response,
    });

    expect(outputHandler).toHaveBeenCalledWith(message);
    expect(statusHandler).toHaveBeenCalledWith('busy');
    expect(completeHandler).toHaveBeenCalledWith(response);
  });

  it('reports local-model runtime capabilities', () => {
    expect(adapter.getEndpointProvider()).toBe('openai-compatible');
    expect(adapter.getModelId()).toBe('qwen2.5-coder-14b');
    expect(adapter.getRuntimeCapabilities()).toMatchObject({
      supportsResume: false,
      supportsForkSession: false,
      supportsPermissionPrompts: false,
      selfManagedAutoCompaction: false,
    });
  });
});
