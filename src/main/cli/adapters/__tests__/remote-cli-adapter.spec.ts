import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock logger to avoid side-effects during tests.
vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { RemoteCliAdapter } from '../remote-cli-adapter';
import type { WorkerNodeConnectionServer } from '../../../remote-node/worker-node-connection';
import type { UnifiedSpawnOptions } from '../adapter-factory';
import type { FileAttachment } from '../../../../shared/types/instance.types';

function createMockConnection() {
  return {
    sendRpc: vi.fn(),
    sendNotification: vi.fn(),
    isNodeConnected: vi.fn().mockReturnValue(true),
  } as unknown as WorkerNodeConnectionServer;
}

const TARGET_NODE_ID = 'node-worker-1';
const REMOTE_INSTANCE_ID = 'remote-instance-abc';
const DEFAULT_OPTIONS: UnifiedSpawnOptions = {
  workingDirectory: '/tmp/work',
  systemPrompt: 'Be helpful',
  model: 'claude-opus-4',
};

describe('RemoteCliAdapter', () => {
  let connection: WorkerNodeConnectionServer;
  let adapter: RemoteCliAdapter;

  beforeEach(() => {
    connection = createMockConnection();
    adapter = new RemoteCliAdapter(connection, TARGET_NODE_ID, 'claude', DEFAULT_OPTIONS);
  });

  // ---------------------------------------------------------------------------
  // 1. spawn
  // ---------------------------------------------------------------------------
  describe('spawn', () => {
    it('sends instance.spawn RPC with cliType and options, stores remote instance ID, emits spawned', async () => {
      (connection.sendRpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        instanceId: REMOTE_INSTANCE_ID,
      });

      const spawnedHandler = vi.fn();
      adapter.on('spawned', spawnedHandler);

      await adapter.spawn();

      expect(connection.sendRpc).toHaveBeenCalledWith(TARGET_NODE_ID, 'instance.spawn', {
        requestedCliType: 'claude',
        options: DEFAULT_OPTIONS,
      });

      expect(adapter.getRemoteInstanceId()).toBe(REMOTE_INSTANCE_ID);
      expect(adapter.isRunning()).toBe(true);
      expect(spawnedHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. sendInput: happy path
  // ---------------------------------------------------------------------------
  describe('sendInput', () => {
    it('sends instance.sendInput RPC with instanceId and message after spawning', async () => {
      (connection.sendRpc as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ instanceId: REMOTE_INSTANCE_ID }) // spawn
        .mockResolvedValueOnce(undefined); // sendInput

      await adapter.spawn();
      await adapter.sendInput('Hello, world!');

      expect(connection.sendRpc).toHaveBeenNthCalledWith(2, TARGET_NODE_ID, 'instance.sendInput', {
        instanceId: REMOTE_INSTANCE_ID,
        message: 'Hello, world!',
        attachments: undefined,
      });
    });

    it('includes attachments in the sendInput RPC when provided', async () => {
      (connection.sendRpc as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ instanceId: REMOTE_INSTANCE_ID })
        .mockResolvedValueOnce(undefined);

      const attachments: FileAttachment[] = [
        { name: 'file.txt', type: 'text/plain', size: 42, data: 'aGVsbG8=' },
      ];

      await adapter.spawn();
      await adapter.sendInput('Check this file', attachments);

      expect(connection.sendRpc).toHaveBeenNthCalledWith(2, TARGET_NODE_ID, 'instance.sendInput', {
        instanceId: REMOTE_INSTANCE_ID,
        message: 'Check this file',
        attachments,
      });
    });

    it('throws if not yet spawned', async () => {
      await expect(adapter.sendInput('oops')).rejects.toThrow(
        /not spawned/i,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 3. interrupt
  // ---------------------------------------------------------------------------
  describe('interrupt', () => {
    it('sends instance.interrupt RPC after spawning', async () => {
      (connection.sendRpc as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ instanceId: REMOTE_INSTANCE_ID })
        .mockResolvedValueOnce(undefined);

      await adapter.spawn();
      await adapter.interrupt();

      expect(connection.sendRpc).toHaveBeenNthCalledWith(2, TARGET_NODE_ID, 'instance.interrupt', {
        instanceId: REMOTE_INSTANCE_ID,
      });
    });

    it('is a no-op if not spawned', async () => {
      await adapter.interrupt();
      expect(connection.sendRpc).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. terminate
  // ---------------------------------------------------------------------------
  describe('terminate', () => {
    it('sends instance.terminate RPC and clears remote instance ID', async () => {
      (connection.sendRpc as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ instanceId: REMOTE_INSTANCE_ID })
        .mockResolvedValueOnce(undefined);

      await adapter.spawn();
      expect(adapter.isRunning()).toBe(true);

      await adapter.terminate();

      expect(connection.sendRpc).toHaveBeenNthCalledWith(2, TARGET_NODE_ID, 'instance.terminate', {
        instanceId: REMOTE_INSTANCE_ID,
      });
      expect(adapter.getRemoteInstanceId()).toBeNull();
      expect(adapter.isRunning()).toBe(false);
    });

    it('is a no-op if not spawned', async () => {
      await adapter.terminate();
      expect(connection.sendRpc).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Accessors
  // ---------------------------------------------------------------------------
  describe('accessors', () => {
    it('getTargetNodeId returns the node ID', () => {
      expect(adapter.getTargetNodeId()).toBe(TARGET_NODE_ID);
    });

    it('getRemoteInstanceId returns null before spawning', () => {
      expect(adapter.getRemoteInstanceId()).toBeNull();
    });

    it('isRunning returns false before spawning', () => {
      expect(adapter.isRunning()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. handleRemoteOutput
  // ---------------------------------------------------------------------------
  describe('handleRemoteOutput', () => {
    it('emits output event with the message', () => {
      const outputHandler = vi.fn();
      adapter.on('output', outputHandler);

      const message = { type: 'text', content: 'Hello from remote', timestamp: 1000 };
      adapter.handleRemoteOutput(message);

      expect(outputHandler).toHaveBeenCalledWith(message);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. handleRemoteExit
  // ---------------------------------------------------------------------------
  describe('handleRemoteExit', () => {
    it('emits exit event with code and clears remote instance ID', async () => {
      (connection.sendRpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        instanceId: REMOTE_INSTANCE_ID,
      });

      await adapter.spawn();
      expect(adapter.isRunning()).toBe(true);

      const exitHandler = vi.fn();
      adapter.on('exit', exitHandler);

      adapter.handleRemoteExit(0);

      expect(exitHandler).toHaveBeenCalledWith({ code: 0 });
      expect(adapter.getRemoteInstanceId()).toBeNull();
      expect(adapter.isRunning()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. handleRemoteStateChange
  // ---------------------------------------------------------------------------
  describe('handleRemoteStateChange', () => {
    it('emits both stateChange and status events', () => {
      const stateChangeHandler = vi.fn();
      const statusHandler = vi.fn();
      adapter.on('stateChange', stateChangeHandler);
      adapter.on('status', statusHandler);

      adapter.handleRemoteStateChange('busy');

      expect(stateChangeHandler).toHaveBeenCalledWith('busy');
      expect(statusHandler).toHaveBeenCalledWith('busy');
    });
  });

  // ---------------------------------------------------------------------------
  // 9. handleRemoteError
  // ---------------------------------------------------------------------------
  describe('handleRemoteError', () => {
    it('emits error event with an Error object', () => {
      const errorHandler = vi.fn();
      adapter.on('error', errorHandler);

      adapter.handleRemoteError('Something went wrong on the remote');

      expect(errorHandler).toHaveBeenCalledTimes(1);
      const emittedError: unknown = errorHandler.mock.calls[0][0];
      expect(emittedError).toBeInstanceOf(Error);
      expect((emittedError as Error).message).toContain('Something went wrong on the remote');
    });
  });

  // ---------------------------------------------------------------------------
  // 10. handleRemotePermissionRequest
  // ---------------------------------------------------------------------------
  describe('handleRemotePermissionRequest', () => {
    it('emits input_required event with the payload', () => {
      const permHandler = vi.fn();
      adapter.on('input_required', permHandler);

      const payload = { tool: 'bash', command: 'rm -rf /', requiresApproval: true };
      adapter.handleRemotePermissionRequest(payload);

      expect(permHandler).toHaveBeenCalledWith(payload);
    });
  });
});
