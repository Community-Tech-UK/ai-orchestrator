import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const createAdapter = vi.hoisted(() => vi.fn());
vi.mock('../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: createAdapter }));
import { LocalInstanceManager, type SpawnParams } from './local-instance-manager';

function adapter() {
  return Object.assign(new EventEmitter(), {
    spawn: vi.fn().mockResolvedValue(1), sendInput: vi.fn().mockResolvedValue(undefined), terminate: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn(), hasActiveTurn: vi.fn(() => false), hasActiveToolCalls: vi.fn(() => false),
  });
}
describe('worker model replacement', () => {
  let manager: LocalInstanceManager;
  let old: ReturnType<typeof adapter>;
  const params: SpawnParams = { instanceId: 'old', cliType: 'codex', workingDirectory: '/tmp', model: 'before' };
  const next: SpawnParams = { ...params, instanceId: 'next', model: 'after', reasoningEffort: 'high', resume: true, sessionId: 'provider-session' };
  beforeEach(async () => {
    vi.clearAllMocks(); manager = new LocalInstanceManager(['/tmp']); old = adapter(); createAdapter.mockReturnValue(old);
    await manager.spawn(params); old.emit('status', 'idle');
  });
  afterEach(async () => { await manager.terminateAll(); });
  it('uses the supplied continuity options and suppresses old adapter exits', async () => {
    const replacement = adapter(); createAdapter.mockReturnValue(replacement);
    const exits = vi.fn(); manager.on('instance:exit', exits);
    old.terminate.mockImplementation(async () => { old.emit('exit', 0, null); });
    await manager.changeModel('old', next);
    expect(old.terminate).toHaveBeenCalledOnce();
    expect(createAdapter).toHaveBeenLastCalledWith('codex', expect.objectContaining({ model: 'after', reasoningEffort: 'high', resume: true, sessionId: 'provider-session' }));
    expect(manager.getInstance('old')).toBeUndefined(); expect(manager.getInstance('next')?.adapter).toBe(replacement);
    old.emit('exit', 0, null); expect(exits).not.toHaveBeenCalled(); expect(manager.getInstance('next')?.adapter).toBe(replacement);
  });
  it.each(['busy', 'thinking_deeply', 'waiting_for_permission'])('refuses %s without teardown', async status => {
    old.emit('status', status);
    await expect(manager.changeModel('old', next)).rejects.toThrow(/Model changes/);
    expect(old.terminate).not.toHaveBeenCalled(); expect(manager.getInstance('old')?.adapter).toBe(old);
  });
  it.each(['hasActiveTurn', 'hasActiveToolCalls'] as const)('checks %s even when status appears idle', async probe => {
    old[probe].mockReturnValue(true);
    await expect(manager.changeModel('old', next)).rejects.toThrow(/turn is still running/);
    expect(old.terminate).not.toHaveBeenCalled();
  });
  it.each([{ cliType: 'claude' }, { workingDirectory: '/etc' }, { accountRoute: { profileId: 'different' } }])('rejects a different execution identity before teardown: %j', async changes => {
    await expect(manager.changeModel('old', { ...next, ...changes } as SpawnParams)).rejects.toThrow();
    expect(old.terminate).not.toHaveBeenCalled();
  });
  it('blocks prompts and a second switch while teardown is pending', async () => {
    let finish!: () => void; old.terminate.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    createAdapter.mockReturnValue(adapter());
    const changing = manager.changeModel('old', next);
    await vi.waitFor(() => expect(old.terminate).toHaveBeenCalled());
    await expect(manager.sendInput('old', 'race')).rejects.toThrow(/model change/);
    await expect(manager.changeModel('old', next)).rejects.toThrow(/model change/);
    finish(); await changing;
  });
  it('does not leave a replacement record when spawning fails', async () => {
    createAdapter.mockImplementationOnce(() => { throw new Error('spawn failed'); });
    await expect(manager.changeModel('old', next)).rejects.toMatchObject({ message: 'spawn failed', previousRuntime: 'terminated' });
    expect(manager.getInstance('next')).toBeUndefined();
  });
  it('reports uncertainty when stopping the old process fails, without attempting replacement', async () => {
    old.terminate.mockRejectedValueOnce(new Error('termination failed'));
    await expect(manager.changeModel('old', next)).rejects.toMatchObject({ message: 'termination failed', previousRuntime: 'unknown' });
    expect(createAdapter).toHaveBeenCalledOnce();
  });
  it('keeps existing machine-session limits when changing only the model', async () => {
    await manager.terminate('old');
    await manager.spawn({ ...params, cliType: 'claude', claudeSpawnPolicy: { machineSession: 'node-run', readOnlyReview: true, maxTurns: 3 } });
    old.emit('status', 'idle'); createAdapter.mockReturnValue(adapter());
    await manager.changeModel('old', { ...next, cliType: 'claude' });
    expect(createAdapter).toHaveBeenLastCalledWith('claude', expect.objectContaining({ machineSession: 'node-run', readOnlyReview: true, maxTurns: 3 }));
  });
  it('does not respawn after a concurrent stop', async () => {
    let finish!: () => void;
    old.terminate.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const changing = manager.changeModel('old', next);
    const outcome = changing.catch(error => error);
    await vi.waitFor(() => expect(old.terminate).toHaveBeenCalled());
    await manager.terminate('old'); finish();
    expect(await outcome).toMatchObject({ message: expect.stringMatching(/cancelled/), previousRuntime: 'unknown' });
    expect(createAdapter).toHaveBeenCalledOnce(); expect(manager.getInstanceCount()).toBe(0);
  });
  it('ignores stale heartbeat and idle-stream events after replacing the same remote identity', async () => {
    const replacement = adapter(); createAdapter.mockReturnValue(replacement);
    await manager.changeModel('old', { ...next, instanceId: 'old' });
    const states = vi.fn(); manager.on('instance:stateChange', states);
    old.emit('heartbeat'); old.emit('stream:idle'); old.emit('exit', 0, null);
    expect(states).not.toHaveBeenCalled(); expect(manager.getInstance('old')?.adapter).toBe(replacement);
  });
});
