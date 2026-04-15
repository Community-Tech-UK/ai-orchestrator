import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalInstanceManager } from '../local-instance-manager';

class MockWorkerAdapter extends EventEmitter {
  spawn = vi.fn(async () => 123);
  sendInput = vi.fn(async () => undefined);
  terminate = vi.fn(async () => undefined);
  interrupt = vi.fn(async () => undefined);
}

let mockAdapter: MockWorkerAdapter;
const mockCreateCliAdapter = vi.fn(() => mockAdapter);

vi.mock('../../main/cli/adapters/adapter-factory', () => ({
  createCliAdapter: (...args: unknown[]) => mockCreateCliAdapter(...args),
}));

describe('LocalInstanceManager', () => {
  let manager: LocalInstanceManager;

  beforeEach(() => {
    mockAdapter = new MockWorkerAdapter();
    mockCreateCliAdapter.mockClear();
    manager = new LocalInstanceManager(['/tmp/allowed']);
  });

  it('starts with zero instances', () => {
    expect(manager.getInstanceCount()).toBe(0);
    expect(manager.getAllInstanceIds()).toEqual([]);
  });

  it('rejects spawn for invalid working directory', async () => {
    await expect(
      manager.spawn({
        instanceId: 'test-1',
        cliType: 'claude',
        workingDirectory: '/etc/not-allowed',
        systemPrompt: 'test',
      }),
    ).rejects.toThrow('not in allowed working directories');
  });

  it('rejects spawn beyond capacity', async () => {
    const smallManager = new LocalInstanceManager(['/tmp'], 0);
    await expect(
      smallManager.spawn({
        instanceId: 'test-1',
        cliType: 'claude',
        workingDirectory: '/tmp',
        systemPrompt: 'test',
      }),
    ).rejects.toThrow('at capacity');
  });

  it('forwards adapter status events as instance state changes', async () => {
    const stateHandler = vi.fn();
    manager.on('instance:stateChange', stateHandler);

    await manager.spawn({
      instanceId: 'test-2',
      cliType: 'claude',
      workingDirectory: '/tmp/allowed',
    });

    mockAdapter.emit('status', 'busy');

    expect(stateHandler).toHaveBeenCalledWith('test-2', 'busy');
  });

  it('forwards adapter input_required events as permission requests', async () => {
    const permissionHandler = vi.fn();
    manager.on('instance:permissionRequest', permissionHandler);

    await manager.spawn({
      instanceId: 'test-3',
      cliType: 'claude',
      workingDirectory: '/tmp/allowed',
    });

    const permission = { id: 'perm-1', prompt: 'Allow action?' };
    mockAdapter.emit('input_required', permission);

    expect(permissionHandler).toHaveBeenCalledWith('test-3', permission);
  });

  it('hibernates an instance and wakes it with resume enabled', async () => {
    await manager.spawn({
      instanceId: 'test-4',
      cliType: 'claude',
      workingDirectory: '/tmp/allowed',
      systemPrompt: 'test',
    });

    await manager.hibernate('test-4');

    expect(mockAdapter.terminate).toHaveBeenCalledOnce();
    expect(manager.getInstanceCount()).toBe(0);

    mockCreateCliAdapter.mockClear();
    mockAdapter = new MockWorkerAdapter();

    await manager.wake('test-4');

    expect(mockCreateCliAdapter).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        sessionId: 'test-4',
        resume: true,
      }),
    );
    expect(manager.getInstanceCount()).toBe(1);
  });
});
