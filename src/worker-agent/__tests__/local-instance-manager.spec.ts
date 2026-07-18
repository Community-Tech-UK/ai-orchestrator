import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalInstanceManager } from '../local-instance-manager';

class MockWorkerAdapter extends EventEmitter {
  spawn = vi.fn(async () => 123);
  sendInput = vi.fn(async () => undefined);
  terminate = vi.fn(async () => undefined);
  interrupt = vi.fn(async () => undefined);
}

class ControlledWorkerAdapter extends EventEmitter {
  private resolveSpawnPromise: (() => void) | null = null;
  spawn = vi.fn(() =>
    new Promise<number>((resolve) => {
      this.resolveSpawnPromise = () => resolve(123);
    })
  );
  sendInput = vi.fn(async () => undefined);
  terminate = vi.fn(async () => undefined);
  interrupt = vi.fn(async () => undefined);

  resolveSpawn(): void {
    if (!this.resolveSpawnPromise) {
      throw new Error('spawn has not started');
    }
    this.resolveSpawnPromise();
  }
}

let mockAdapter: MockWorkerAdapter;
const mockCreateCliAdapter = vi.fn<(...args: unknown[]) => MockWorkerAdapter>(() => mockAdapter);

vi.mock('../../main/cli/adapters/adapter-factory', () => ({
  createCliAdapter: (...args: unknown[]) => mockCreateCliAdapter(...args),
}));

describe('LocalInstanceManager', () => {
  let manager: LocalInstanceManager;

  beforeEach(() => {
    mockAdapter = new MockWorkerAdapter();
    mockCreateCliAdapter.mockReset();
    mockCreateCliAdapter.mockImplementation(() => mockAdapter);
    manager = new LocalInstanceManager(['/tmp/allowed']);
  });

  it('starts with zero instances', () => {
    expect(manager.getInstanceCount()).toBe(0);
    expect(manager.getAllInstanceIds()).toEqual([]);
  });

  describe('relayResumeProof (P2.9)', () => {
    const relay = (id: string, adapter: unknown): void =>
      (manager as unknown as { relayResumeProof: (i: string, a: unknown) => void })
        .relayResumeProof(id, adapter);

    it('emits a resume_proof state-change carrying the proof, deduped on repeat', () => {
      const proof = { source: 'native', confirmed: true, requestedSessionId: 's1', actualSessionId: 's1' };
      const adapter = { getResumeAttemptResult: vi.fn(() => proof) };
      const onState = vi.fn();
      manager.on('instance:stateChange', onState);

      relay('inst-1', adapter);
      expect(onState).toHaveBeenCalledTimes(1);
      expect(onState).toHaveBeenCalledWith('inst-1', 'resume_proof', proof);

      // Same proof again — deduped, no second emit.
      relay('inst-1', adapter);
      expect(onState).toHaveBeenCalledTimes(1);

      // Proof changes (pending → confirmed transition) — relayed again.
      adapter.getResumeAttemptResult.mockReturnValue({ ...proof, confirmed: false });
      relay('inst-1', adapter);
      expect(onState).toHaveBeenCalledTimes(2);
    });

    it('does not emit when the adapter has no meaningful proof', () => {
      const onState = vi.fn();
      manager.on('instance:stateChange', onState);

      relay('inst-1', { getResumeAttemptResult: () => null });
      relay('inst-2', { getResumeAttemptResult: () => ({ source: 'none' }) });
      relay('inst-3', {}); // adapter without the method

      expect(onState).not.toHaveBeenCalled();
    });
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

  it('treats allowed working directories case-insensitively on Windows', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const windowsManager = new LocalInstanceManager(['/tmp/Allowed']);

    try {
      await expect(
        windowsManager.spawn({
          instanceId: 'case-insensitive',
          cliType: 'claude',
          workingDirectory: '/tmp/allowed/project',
        }),
      ).resolves.toBeUndefined();
    } finally {
      platform.mockRestore();
    }
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

  it('reserves capacity while a spawn is still starting', async () => {
    const pendingAdapter = new ControlledWorkerAdapter();
    const secondAdapter = new MockWorkerAdapter();
    mockCreateCliAdapter
      .mockReturnValueOnce(pendingAdapter)
      .mockReturnValueOnce(secondAdapter);
    const smallManager = new LocalInstanceManager(['/tmp/allowed'], 1);

    const firstSpawn = smallManager.spawn({
      instanceId: 'pending-1',
      cliType: 'claude',
      workingDirectory: '/tmp/allowed',
    });
    await waitForSpawnToStart(pendingAdapter);

    await expect(
      smallManager.spawn({
        instanceId: 'pending-2',
        cliType: 'claude',
        workingDirectory: '/tmp/allowed',
      }),
    ).rejects.toThrow('at capacity');

    pendingAdapter.resolveSpawn();
    await firstSpawn;
    expect(secondAdapter.spawn).not.toHaveBeenCalled();
    expect(smallManager.getAllInstanceIds()).toEqual(['pending-1']);
  });

  it('rejects duplicate instance IDs while the first spawn is still starting', async () => {
    const pendingAdapter = new ControlledWorkerAdapter();
    const secondAdapter = new MockWorkerAdapter();
    mockCreateCliAdapter
      .mockReturnValueOnce(pendingAdapter)
      .mockReturnValueOnce(secondAdapter);
    const smallManager = new LocalInstanceManager(['/tmp/allowed'], 2);

    const firstSpawn = smallManager.spawn({
      instanceId: 'same-id',
      cliType: 'claude',
      workingDirectory: '/tmp/allowed',
    });
    await waitForSpawnToStart(pendingAdapter);

    await expect(
      smallManager.spawn({
        instanceId: 'same-id',
        cliType: 'claude',
        workingDirectory: '/tmp/allowed',
      }),
    ).rejects.toThrow('Instance already exists');

    pendingAdapter.resolveSpawn();
    await firstSpawn;
    expect(secondAdapter.spawn).not.toHaveBeenCalled();
    expect(smallManager.getAllInstanceIds()).toEqual(['same-id']);
  });

  it('does not leave a pending spawn running after terminateAll', async () => {
    const pendingAdapter = new ControlledWorkerAdapter();
    mockCreateCliAdapter.mockReturnValueOnce(pendingAdapter);

    const spawnPromise = manager.spawn({
      instanceId: 'pending-shutdown',
      cliType: 'claude',
      workingDirectory: '/tmp/allowed',
    });
    await waitForSpawnToStart(pendingAdapter);

    const terminateAllPromise = manager.terminateAll();
    pendingAdapter.resolveSpawn();

    await expect(spawnPromise).rejects.toThrow('cancelled during shutdown');
    await terminateAllPromise;
    expect(pendingAdapter.terminate).toHaveBeenCalledOnce();
    expect(manager.getInstanceCount()).toBe(0);
    expect(manager.getAllInstanceIds()).toEqual([]);
  });

  it('cancels a single pending spawn when terminate is requested before startup finishes', async () => {
    const pendingAdapter = new ControlledWorkerAdapter();
    mockCreateCliAdapter.mockReturnValueOnce(pendingAdapter);

    const spawnPromise = manager.spawn({
      instanceId: 'pending-terminate',
      cliType: 'claude',
      workingDirectory: '/tmp/allowed',
    });
    await waitForSpawnToStart(pendingAdapter);

    const terminatePromise = manager.terminate('pending-terminate');
    pendingAdapter.resolveSpawn();

    await expect(spawnPromise).rejects.toThrow('spawn cancelled');
    await terminatePromise;
    expect(pendingAdapter.terminate).toHaveBeenCalled();
    expect(manager.getInstanceCount()).toBe(0);
    expect(manager.getAllInstanceIds()).toEqual([]);
  });

  describe('spawn failure accounting (worker-side leak invariants)', () => {
    const spyRelease = (m: LocalInstanceManager) =>
      vi.spyOn(
        m as unknown as { releaseAndroidLease: (id: string) => void },
        'releaseAndroidLease',
      );

    it('adapter creation throwing mid-spawn leaves no leaked accounting', async () => {
      const releaseSpy = spyRelease(manager);
      mockCreateCliAdapter.mockImplementationOnce(() => {
        throw new Error('adapter factory failed');
      });

      await expect(
        manager.spawn({
          instanceId: 'factory-throw',
          cliType: 'claude',
          workingDirectory: '/tmp/allowed',
        }),
      ).rejects.toThrow('adapter factory failed');

      expect(manager.getInstance('factory-throw')).toBeUndefined();
      expect(manager.getInstanceCount()).toBe(0);
      expect(manager.getAllInstanceIds()).toEqual([]);
      expect(releaseSpy).toHaveBeenCalledWith('factory-throw');

      // pendingSpawns was cleared: the id can be spawned again without "already exists".
      mockCreateCliAdapter.mockImplementationOnce(() => mockAdapter);
      await expect(
        manager.spawn({
          instanceId: 'factory-throw',
          cliType: 'claude',
          workingDirectory: '/tmp/allowed',
        }),
      ).resolves.toBeUndefined();
      expect(manager.getInstanceCount()).toBe(1);
    });

    it('adapter.spawn() rejection leaves no leaked accounting', async () => {
      const releaseSpy = spyRelease(manager);
      mockAdapter.spawn.mockRejectedValueOnce(new Error('remote spawn rejected'));

      await expect(
        manager.spawn({
          instanceId: 'spawn-reject',
          cliType: 'claude',
          workingDirectory: '/tmp/allowed',
        }),
      ).rejects.toThrow('remote spawn rejected');

      expect(manager.getInstance('spawn-reject')).toBeUndefined();
      expect(manager.getInstanceCount()).toBe(0);
      expect(manager.getAllInstanceIds()).toEqual([]);
      expect(releaseSpy).toHaveBeenCalledWith('spawn-reject');
    });

    it('getInstance during the pending window returns undefined without corrupting accounting', async () => {
      const pendingAdapter = new ControlledWorkerAdapter();
      mockCreateCliAdapter.mockReturnValueOnce(pendingAdapter);

      const spawnPromise = manager.spawn({
        instanceId: 'pending-lookup',
        cliType: 'claude',
        workingDirectory: '/tmp/allowed',
      });
      await waitForSpawnToStart(pendingAdapter);

      // Mid-spawn: the instance is not yet in the map.
      expect(manager.getInstance('pending-lookup')).toBeUndefined();
      expect(manager.getInstanceCount()).toBe(0);

      pendingAdapter.resolveSpawn();
      await spawnPromise;

      expect(manager.getInstance('pending-lookup')).toBeDefined();
      expect(manager.getInstanceCount()).toBe(1);
    });
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

  it('forwards adapter output through normalized output messages', async () => {
    const outputHandler = vi.fn();
    manager.on('instance:output', outputHandler);

    await manager.spawn({
      instanceId: 'test-output',
      cliType: 'claude',
      workingDirectory: '/tmp/allowed',
    });

    mockAdapter.emit('output', 'hello from worker');

    expect(outputHandler).toHaveBeenCalledWith(
      'test-output',
      expect.objectContaining({
        type: 'assistant',
        content: 'hello from worker',
      }),
    );
  });

  it('forwards adapter heartbeat events as instance liveness events', async () => {
    const heartbeatHandler = vi.fn();
    manager.on('instance:heartbeat', heartbeatHandler);

    await manager.spawn({
      instanceId: 'test-heartbeat',
      cliType: 'codex',
      workingDirectory: '/tmp/allowed',
    });

    mockAdapter.emit('heartbeat');

    expect(heartbeatHandler).toHaveBeenCalledWith('test-heartbeat');
  });

  it('forwards adapter complete events with the original response payload', async () => {
    const completeHandler = vi.fn();
    manager.on('instance:complete', completeHandler);

    await manager.spawn({
      instanceId: 'test-complete',
      cliType: 'codex',
      workingDirectory: '/tmp/allowed',
    });

    const response = {
      id: 'response-1',
      role: 'assistant' as const,
      content: 'done',
      usage: { totalTokens: 42, duration: 500 },
    };
    mockAdapter.emit('complete', response);

    expect(completeHandler).toHaveBeenCalledWith('test-complete', response);
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

  it('keeps hibernated metadata when wake fails so it can be retried', async () => {
    await manager.spawn({
      instanceId: 'retry-wake',
      cliType: 'claude',
      workingDirectory: '/tmp/allowed',
      systemPrompt: 'test',
    });

    await manager.hibernate('retry-wake');

    mockCreateCliAdapter.mockImplementationOnce(() => {
      throw new Error('adapter factory failed');
    });
    await expect(manager.wake('retry-wake')).rejects.toThrow('adapter factory failed');

    mockAdapter = new MockWorkerAdapter();
    mockCreateCliAdapter.mockImplementation(() => mockAdapter);
    await expect(manager.wake('retry-wake')).resolves.toBeUndefined();
    expect(manager.getInstance('retry-wake')).toBeDefined();
  });
});

async function waitForSpawnToStart(adapter: ControlledWorkerAdapter): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (adapter.spawn.mock.calls.length > 0) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('adapter spawn did not start');
}
