import { EventEmitter } from 'events';
import { execFile, type ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { SpawnParams } from './local-instance-manager';
import type { RpcMessage } from './worker-rpc-types';
import type { WorkerNodeConnectionServer } from '../main/remote-node/worker-node-connection';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn();
  return { ...actual, execFile, default: { ...actual, execFile } };
});
vi.mock('../main/logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
const mocks = vi.hoisted(() => ({ createAdapter: vi.fn() }));
vi.mock('../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: mocks.createAdapter }));

import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import { LocalInstanceManager } from './local-instance-manager';
import { RemoteCliAdapter } from '../main/cli/adapters/remote-cli-adapter';
import { RPC_ERROR_CODES } from '../main/remote-node/worker-node-rpc';

const mockExecFile = vi.mocked(execFile);
const base = { instanceId: 'synthetic-instance', cliType: 'opencode', workingDirectory: '/tmp/allowed/project', model: 'xiaomi-token-plan-ams/mimo-v2.6-pro' };
let manager: LocalInstanceManager;
let managerSpawn: MockInstance<(params: SpawnParams) => Promise<void>>;
let adapterSpawn: ReturnType<typeof vi.fn>;
let browserStart: ReturnType<typeof vi.fn>;
let dispatcher: WorkerRpcDispatcher;
let sendResult: ReturnType<typeof vi.fn>;
let sendError: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFile.mockImplementation((_file, _args, _options, callback) => {
    if (!callback) throw new Error('Missing fixture callback');
    queueMicrotask(() => callback(null, '┌  Credentials\n●  aio-mimo-synthetic-b api\n●  xiaomi-token-plan-ams api\n●  xiaomi-token-plan-sgp api\n●  xiaomi-token-plan-cn api\n└  4 credentials\n', ''));
    return {} as ChildProcess;
  });
  adapterSpawn = vi.fn(async () => 1);
  mocks.createAdapter.mockImplementation(() => Object.assign(new EventEmitter(), { spawn: adapterSpawn, terminate: vi.fn(async () => undefined) }));
  browserStart = vi.fn(async () => 'http://worker-placeholder:9222');
  manager = new LocalInstanceManager(['/tmp/allowed'], 10, { isEnabled: () => true, ensureRunning: browserStart } as never);
  managerSpawn = vi.spyOn(manager, 'spawn');
  sendResult = vi.fn();
  sendError = vi.fn();
  dispatcher = new WorkerRpcDispatcher({
    config: {} as never, instanceManager: manager,
    getFilesystemHandler: () => ({}) as never, getSyncHandler: () => ({}) as never,
    getTerminalHandler: () => ({}) as never, applyConfigUpdate: vi.fn() as never,
    getCdpTunnel: () => ({}) as never, stopManagedBrowser: vi.fn(),
    executeNodeCommand: vi.fn(), localAiHealth: {} as never, sendResult, sendError,
  });
});

afterEach(async () => { await manager.terminateAll(); });

const request = (params: unknown): RpcMessage => ({ jsonrpc: '2.0', id: 1, method: 'instance.spawn', scope: 'instance', params });

describe('actual instance.spawn executing-worker account ingress', () => {
  it.each([
    ['unknown', 'moon'], ['missing', undefined], ['null', null], ['empty', ''],
    ['object', { region: 'ams' }], ['array', ['ams']], ['boolean', true], ['number', 1],
    ['padded', ' ams'], ['uppercase', 'AMS'], ['shell-shaped', 'ams & echo AIO_REGION_PLACEHOLDER &'],
  ])('refuses %s regions before manager, browser, binding or adapter startup', async (_name, region) => {
    for (const profileId of ['synthetic-b', 'legacy']) {
      await dispatcher.handleRpcRequest(request({ ...base, accountRoute: { provider: 'opencode', profileId, region } }));
    }
    expect(sendError).toHaveBeenCalledTimes(2);
    expect(sendError).toHaveBeenCalledWith(1, RPC_ERROR_CODES.INVALID_PARAMS, expect.any(String));
    expect(sendResult).not.toHaveBeenCalled();
    expect(managerSpawn).not.toHaveBeenCalled();
    expect(browserStart).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mocks.createAdapter).not.toHaveBeenCalled();
    expect(adapterSpawn).not.toHaveBeenCalled();
  });

  it.each([null, [], 'route-placeholder', {}, { provider: 'gemini', profileId: 'synthetic-b' }, { provider: 'opencode', profileId: '../escape', region: 'ams' }])('rejects malformed route objects at the actual dispatcher (%j)', async (accountRoute) => {
      await dispatcher.handleRpcRequest(request({ ...base, accountRoute }));
      expect(sendError).toHaveBeenCalledWith(1, RPC_ERROR_CODES.INVALID_PARAMS, expect.any(String));
      expect(sendResult).not.toHaveBeenCalled();
      expect(managerSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

  it.each(['ams', 'sgp', 'cn'] as const)('materializes authenticated custom and legacy %s routes through the actual manager', async (region) => {
    for (const profileId of ['synthetic-b', 'legacy']) {
      await dispatcher.handleRpcRequest(request({ ...base, instanceId: profileId, accountRoute: { provider: 'opencode', profileId, region, expectedIdentity: null, source: 'failover' } }));
    }
    expect(sendError).not.toHaveBeenCalled();
    expect(sendResult).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(adapterSpawn).toHaveBeenCalledTimes(2);
    expect(mocks.createAdapter.mock.calls.map((call) => call[1].accountRoute)).toEqual(['synthetic-b', 'legacy'].map((profileId) => ({ provider: 'opencode', profileId, region, source: 'persisted', executionNodeId: 'worker' })));
  });

  it('rejects a provider mismatch before manager startup with INVALID_PARAMS', async () => {
    await dispatcher.handleRpcRequest(request({ ...base, cliType: 'claude', accountRoute: { provider: 'codex', profileId: 'synthetic-b' } }));
    expect(sendError).toHaveBeenCalledWith(1, RPC_ERROR_CODES.INVALID_PARAMS, 'A codex account route was sent with a claude spawn.');
    expect(managerSpawn).not.toHaveBeenCalled();
    expect(sendResult).not.toHaveBeenCalled();
  });

  it('retains SPAWN_FAILED for a valid request that fails actual worker binding', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      if (!callback) throw new Error('Missing fixture callback');
      queueMicrotask(() => callback(null, '┌  Credentials\n└  0 credentials\n', ''));
      return {} as ChildProcess;
    });
    await dispatcher.handleRpcRequest(request({ ...base, accountRoute: { provider: 'opencode', profileId: 'synthetic-b', region: 'ams' } }));
    expect(sendError).toHaveBeenCalledWith(1, RPC_ERROR_CODES.SPAWN_FAILED, expect.stringContaining('not signed in on this node'));
    expect(managerSpawn).toHaveBeenCalledOnce();
    expect(mockExecFile).toHaveBeenCalledOnce();
    expect(sendResult).not.toHaveBeenCalled();
    expect(mocks.createAdapter).not.toHaveBeenCalled();
    expect(adapterSpawn).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex', 'opencode'] as const)('retains unrouted %s spawns', async (cliType) => {
    await dispatcher.handleRpcRequest(request({ ...base, cliType }));
    expect(sendError).not.toHaveBeenCalled();
    expect(sendResult).toHaveBeenCalledWith(1, { instanceId: base.instanceId });
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(adapterSpawn).toHaveBeenCalledOnce();
    expect(mocks.createAdapter.mock.calls[0]?.[1]).not.toHaveProperty('accountRoute');
  });

  it.each(['claude', 'codex', 'opencode'] as const)('accepts actual controller-emitted %s wire including optional/default metadata', async (cliType) => {
    const emitted: unknown[] = [];
    // Isolate native sign-in for these compatibility controls; ingress/schema is real.
    managerSpawn.mockImplementation(async (params: SpawnParams) => { emitted.push(params); });
    const connection = { sendRpc: vi.fn(async (_node, _method, params) => {
      await dispatcher.handleRpcRequest(request(JSON.parse(JSON.stringify(params))));
      return { instanceId: base.instanceId };
    }) } as unknown as WorkerNodeConnectionServer;
    const remote = new RemoteCliAdapter(connection, 'worker-placeholder', cliType, {
      sessionId: base.instanceId, workingDirectory: base.workingDirectory, model: base.model,
      reasoningEffort: 'high', resume: true, forkSession: false, yoloMode: false,
      allowedTools: [], disallowedTools: [], mcpConfig: [], nodePlacement: { requiresBrowser: false },
      accountRoute: { provider: cliType, profileId: 'synthetic-b', source: 'persisted', executionNodeId: 'worker-placeholder', ...(cliType === 'opencode' ? { region: 'sgp' as const } : {}) },
    });
    try {
      await remote.spawn();
      expect(sendError).not.toHaveBeenCalled();
      expect(emitted).toEqual([expect.objectContaining({ cliType, reasoningEffort: 'high', resume: true, forkSession: false, yoloMode: false,
        allowedTools: [], disallowedTools: [], mcpConfig: [], nodePlacement: { requiresBrowser: false },
        accountRoute: { provider: cliType, profileId: 'synthetic-b', expectedIdentity: null, source: 'persisted', ...(cliType === 'opencode' ? { region: 'sgp' } : {}) },
      })]);
    } finally { remote.forceCleanup(); }
  });
});
