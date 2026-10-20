import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const createAdapter = vi.hoisted(() => vi.fn());
vi.mock('../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: createAdapter }));
import { LocalInstanceManager } from './local-instance-manager';
import type { WorkerAndroidManager } from './android/worker-android-manager';
import { InstanceSpawnParamsSchema } from '../main/remote-node/rpc-schemas';

function fakeAdapter(name: string, runtime: { supportsNativeCompaction?: boolean } = {}): EventEmitter {
  return Object.assign(new EventEmitter(), {
    spawn: vi.fn().mockResolvedValue(1),
    sendInput: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn(() => ({ status: 'already-idle' })),
    getName: () => name,
    getRuntimeCapabilities: () => ({
      supportsResume: true,
      supportsForkSession: false,
      supportsNativeCompaction: runtime.supportsNativeCompaction ?? false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
    }),
  });
}

describe('LocalInstanceManager — carried Claude spawn policy', () => {
  let manager: LocalInstanceManager;
  beforeEach(() => {
    vi.clearAllMocks();
    manager = new LocalInstanceManager(['/tmp']);
    createAdapter.mockImplementation(() => fakeAdapter('claude-cli'));
  });
  afterEach(async () => { await manager.terminateAll(); });

  it('passes the controller-resolved policy to this worker\'s Claude adapter factory', async () => {
    const claudeSpawnPolicy = {
      machineSession: 'node-run' as const,
      contextCeilingTokens: 200_000,
      readOnlyReview: true as const,
      maxTurns: 8,
      maxBudgetUsd: 1,
    };
    await manager.spawn({ instanceId: 'claude-1', cliType: 'claude', workingDirectory: '/tmp', yoloMode: false, claudeSpawnPolicy });

    expect(createAdapter).toHaveBeenCalledWith('claude', expect.objectContaining({
      ...claudeSpawnPolicy,
      yoloMode: false,
    }));
  });

  it('leaves an ordinary Claude spawn without policy fields', async () => {
    await manager.spawn({ instanceId: 'claude-2', cliType: 'claude', workingDirectory: '/tmp' });

    const options = createAdapter.mock.calls[0][1] as Record<string, unknown>;
    for (const key of ['machineSession', 'contextCeilingTokens', 'readOnlyReview', 'maxTurns', 'maxBudgetUsd']) {
      expect(options).not.toHaveProperty(key);
    }
  });

  it('refuses a Claude policy addressed to another provider before building an adapter', async () => {
    await expect(manager.spawn({
      instanceId: 'codex-1', cliType: 'codex', workingDirectory: '/tmp', claudeSpawnPolicy: { maxTurns: 8 },
    })).rejects.toThrow('non-Claude provider');
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('keeps the policy on wire validation and fails closed on an unknown policy field', () => {
    const base = { instanceId: 'claude-3', cliType: 'claude', workingDirectory: '/tmp' };
    expect(InstanceSpawnParamsSchema.parse({ ...base, claudeSpawnPolicy: { machineSession: 'node-run', maxTurns: 8 } }).claudeSpawnPolicy)
      .toEqual({ machineSession: 'node-run', maxTurns: 8 });
    expect(() => InstanceSpawnParamsSchema.parse({ ...base, claudeSpawnPolicy: { maxTurns: 8, futurePolicy: true } })).toThrow();
    expect(() => InstanceSpawnParamsSchema.parse({ ...base, claudeSpawnPolicy: { machineSession: 'not-a-reason' } })).toThrow();
  });
});

describe('LocalInstanceManager — adapter exits and the Android lease', () => {
  const releaseLeaseForInstance = vi.fn();
  const androidManager = { isEnabled: () => false, releaseLeaseForInstance } as unknown as WorkerAndroidManager;
  let manager: LocalInstanceManager;
  let exits: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    manager = new LocalInstanceManager(['/tmp'], 10, null, androidManager);
    exits = vi.fn();
    manager.on('instance:exit', exits);
  });
  afterEach(async () => { await manager.terminateAll(); });

  it('keeps the instance and its lease when an exec-per-turn adapter\'s turn process exits', async () => {
    const adapter = fakeAdapter('codex-cli');
    createAdapter.mockReturnValue(adapter);
    await manager.spawn({ instanceId: 'exec-1', cliType: 'codex', workingDirectory: '/tmp' });

    adapter.emit('exit', 0, null);

    expect(exits).not.toHaveBeenCalled();
    expect(releaseLeaseForInstance).not.toHaveBeenCalled();
    expect(manager.getInstance('exec-1')).toBeDefined();
    await manager.sendInput('exec-1', 'second turn');
    expect((adapter as unknown as { sendInput: ReturnType<typeof vi.fn> }).sendInput).toHaveBeenCalledWith('second turn', undefined);
  });

  it('settles a failed exec-per-turn turn as idle and stops the busy watchdog', async () => {
    vi.useFakeTimers();
    try {
      const adapter = fakeAdapter('cursor-cli');
      createAdapter.mockReturnValue(adapter);
      const states = vi.fn();
      manager.on('instance:stateChange', states);
      await manager.spawn({ instanceId: 'exec-2', cliType: 'cursor', workingDirectory: '/tmp' });
      states.mockClear();

      adapter.emit('status', 'busy');
      adapter.emit('status', 'error');
      vi.advanceTimersByTime(20_000);

      expect(states.mock.calls.map(([, state]) => state)).toEqual(['busy', 'idle']);
      expect(manager.getInstance('exec-2')?.lastStatus).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still forwards a resident adapter\'s error status', async () => {
    const adapter = fakeAdapter('codex-cli', { supportsNativeCompaction: true });
    createAdapter.mockReturnValue(adapter);
    const states = vi.fn();
    manager.on('instance:stateChange', states);
    await manager.spawn({ instanceId: 'resident-2', cliType: 'codex', workingDirectory: '/tmp' });

    adapter.emit('status', 'error');

    expect(states).toHaveBeenLastCalledWith('resident-2', 'error');
  });

  it('ends the instance, releases its lease and forwards the exit for a resident adapter', async () => {
    const adapter = fakeAdapter('codex-cli', { supportsNativeCompaction: true });
    createAdapter.mockReturnValue(adapter);
    await manager.spawn({ instanceId: 'resident-1', cliType: 'codex', workingDirectory: '/tmp' });

    adapter.emit('exit', 137, 'SIGKILL');

    expect(exits).toHaveBeenCalledWith('resident-1', { code: 137, signal: 'SIGKILL' });
    expect(releaseLeaseForInstance).toHaveBeenCalledWith('resident-1');
    expect(manager.getInstance('resident-1')).toBeUndefined();
  });
});
