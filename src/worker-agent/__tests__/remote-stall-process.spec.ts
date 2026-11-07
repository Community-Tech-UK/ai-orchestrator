import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WorkerNodeConnectionServer } from '../../main/remote-node/worker-node-connection';
import type { UnifiedSpawnOptions } from '../../main/cli/adapters/adapter-factory.types';
import type { RpcMessage } from '../worker-rpc-types';

const fixture = vi.hoisted(() => ({ createAdapter: vi.fn(), capable: true }));
const registry = Object.assign(new EventEmitter(), {
  getNode: () => ({ capabilities: { stallProcessSampling: fixture.capable ? 1 : undefined } }),
});
vi.mock('../../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: fixture.createAdapter }));
vi.mock('../../main/remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registry }));
vi.mock('../../main/pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false }) }));

import { LocalInstanceManager } from '../local-instance-manager';
import { WorkerRpcDispatcher } from '../worker-rpc-dispatcher';
import { RemoteCliAdapter } from '../../main/cli/adapters/remote-cli-adapter';
import * as processFacts from '../../main/instance/stall-process-facts';
import { buildStuckNotice } from '../../main/instance/stall-notices';
import { wireInstanceEvents } from '../worker-event-wiring';
import type { WorkerInstanceNotifier } from '../worker-instance-notifier';

const nativeSample = processFacts.sampleStallProcessFacts;
let manager: LocalInstanceManager;
let adapter: RemoteCliAdapter;
let native: EventEmitter & { getPid: () => number };
let sendRpc: Mock<(nodeId: string, method: string, params: unknown) => Promise<unknown>>;

beforeEach(() => {
  fixture.capable = true;
  registry.removeAllListeners();
  native = Object.assign(new EventEmitter(), {
    getPid: () => 100,
    getName: () => 'claude-cli',
    spawn: async () => 100,
    terminate: async () => undefined,
    interrupt: () => ({ status: 'already-idle' }),
    sendInput: async () => undefined,
  });
  fixture.createAdapter.mockReturnValue(native);
  manager = new LocalInstanceManager(['/tmp']);
  const dispatcher = new WorkerRpcDispatcher({
    config: { workingDirectories: ['/tmp'] }, instanceManager: manager,
    sendResult: (_id: unknown, value: unknown) => { response = JSON.parse(JSON.stringify(value)); },
    sendError: (_id: unknown, code: number, message: string) => { failure = Object.assign(new Error(message), { code }); },
  } as never);
  let response: unknown;
  let failure: Error | undefined;
  sendRpc = vi.fn(async (_nodeId: string, method: string, params: unknown) => {
    response = undefined; failure = undefined;
    await dispatcher.handleRpcRequest(JSON.parse(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })) as RpcMessage);
    if (failure) throw failure;
    return response;
  });
  adapter = new RemoteCliAdapter({ sendRpc } as unknown as WorkerNodeConnectionServer,
    'windows-pc', 'claude', { sessionId: 'remote-session', workingDirectory: '/tmp' } as UnifiedSpawnOptions);
});
afterEach(async () => { adapter.forceCleanup(); await manager.terminateAll(); registry.removeAllListeners(); vi.restoreAllMocks(); });

describe('remote stall process path', () => {
  it('gets Windows observations from the worker adapter and uses them in the existing warning', async () => {
    let time = 1000;
    const table = JSON.stringify([
      { pid: 100, ppid: 1, cpuSeconds: 0, runningSeconds: 500, rssMb: 2, command: 'claude.exe' },
      { pid: 101, ppid: 100, cpuSeconds: 0, runningSeconds: 40, rssMb: 2, command: 'npm.exe test --token TOKEN_PLACEHOLDER' },
    ]);
    const sampling = vi.spyOn(processFacts, 'sampleStallProcessFacts').mockImplementation((pid, options) => nativeSample(pid, {
      ...options, platform: 'win32', runWindowsProcessTable: async () => table,
      sleep: async () => { time += 1500; }, now: () => time,
    }));
    await adapter.spawn();
    const warning = await buildStuckNotice({ elapsedMs: 70_000, pid: adapter.getPid(),
      sampleProcessFacts: silence => adapter.sampleStallProcessFacts(silence) });
    expect(sendRpc).toHaveBeenCalledWith('windows-pc', 'instance.sampleStallProcess',
      { instanceId: 'remote-session', silenceMs: 70_000 }, 6000);
    expect(sampling).toHaveBeenCalledExactlyOnceWith(100, { silenceMs: 70_000 });
    expect(warning.content).toContain('waiting on "npm test"');
    expect(warning.metadata).toMatchObject({ watchdogWarning: true, elapsedMs: 70_000,
      processFacts: { pid: 100, child: { label: 'npm test', runningSeconds: 40, cpuPercent: 0 } } });
    expect(JSON.stringify(warning)).not.toContain('TOKEN_PLACEHOLDER');
  });

  it('keeps the normal warning for an older worker without calling an unsupported sampler', async () => {
    fixture.capable = false;
    await adapter.spawn();
    const warning = await buildStuckNotice({ elapsedMs: 70_000, pid: null,
      sampleProcessFacts: silence => adapter.sampleStallProcessFacts(silence) });
    expect(sendRpc.mock.calls.map(call => call[1])).toEqual(['instance.spawn']);
    expect(warning.metadata).toEqual({ watchdogWarning: true, elapsedMs: 70_000, detail: '70s without output' });
  });

  it('relays parameterless stderr through worker wiring without changing visible session status', async () => {
    const sendStateChange = vi.fn((instanceId: string, state: unknown, info: unknown) => {
      registry.emit('remote:instance-state-change', JSON.parse(JSON.stringify({ nodeId: 'windows-pc', instanceId, state, info })));
    });
    wireInstanceEvents(manager, new EventEmitter(), { sendStateChange } as unknown as WorkerInstanceNotifier);
    await adapter.spawn();
    const stderr = vi.fn(); const stateChange = vi.fn();
    adapter.on('stderr', stderr); adapter.on('stateChange', stateChange);
    native.emit('stderr', 'PRIVATE_VALUE_PLACEHOLDER');
    expect(stderr).toHaveBeenCalledExactlyOnceWith();
    expect(stateChange).not.toHaveBeenCalled();
    expect(JSON.stringify(sendStateChange.mock.calls)).not.toContain('PRIVATE_VALUE_PLACEHOLDER');
    registry.emit('remote:instance-state-change', { nodeId: 'windows-pc', instanceId: 'remote-session',
      state: 'stderr_activity', info: { interactionId: 'an-old-spawn' } });
    expect(stderr).toHaveBeenCalledTimes(1);
    await manager.terminate('remote-session');
    expect(native.listenerCount('stderr')).toBe(0);
  });

  it('rejects a supplied PID, negative silence or an unknown instance at the dispatcher', async () => {
    await adapter.spawn();
    await expect(sendRpc('windows-pc', 'instance.sampleStallProcess', { instanceId: 'remote-session', silenceMs: 70_000, pid: 999 }))
      .rejects.toThrow();
    await expect(sendRpc('windows-pc', 'instance.sampleStallProcess', { instanceId: 'remote-session', silenceMs: -1 })).rejects.toThrow();
    await expect(sendRpc('windows-pc', 'instance.sampleStallProcess', { instanceId: 'unknown', silenceMs: 70_000 }))
      .rejects.toThrow('Instance not found');
  });

  it('discards a pending observation when the owning worker adapter is replaced or terminated', async () => {
    let resolve!: (value: processFacts.StallProcessFacts) => void;
    vi.spyOn(processFacts, 'sampleStallProcessFacts').mockReturnValue(new Promise(value => { resolve = value; }));
    await adapter.spawn();
    const pending = adapter.sampleStallProcessFacts(70_000);
    await manager.terminate('remote-session');
    resolve({ pid: 100, state: 'unknown', cpuPercent: 0, rssMb: 2, child: null, sampledAt: 1 });
    expect(await pending).toBeNull();
  });
});
