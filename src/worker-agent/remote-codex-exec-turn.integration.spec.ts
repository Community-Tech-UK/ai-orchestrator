/**
 * Remote Codex exec-mode turns across the real coordinator/worker wire.
 *
 * Regression for the 2026-10-19 run_on_node loop: on the worker, Codex runs one
 * `codex exec` process per turn and the adapter emits `exit` when that process
 * closes. The worker treated it as the session ending (deleted the instance and
 * forwarded `exited`), so the coordinator saw a crash mid-turn, auto-respawned
 * and re-ran the prompt until its continuation cap.
 *
 * Real pieces: CodexCliAdapter (exec mode, fake child process), LocalInstanceManager,
 * WorkerRpcDispatcher, worker event wiring, RPC schemas and RemoteCliAdapter.
 */
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { WorkerNodeConnectionServer } from '../main/remote-node/worker-node-connection';
import type { WorkerInstanceNotifier } from './worker-instance-notifier';

const registryHolder = vi.hoisted(() => ({ value: undefined as unknown }));
const mocks = vi.hoisted(() => ({ adapter: undefined as unknown, kill: vi.fn<(pid: number | undefined, signal: string) => boolean>() }));
vi.mock('../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: () => mocks.adapter }));
vi.mock('../main/logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../main/remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registryHolder.value }));
// Never signal a real process group from a test.
vi.mock('../main/cli/adapters/base-cli-process-utils', async (original) => ({
  ...await original<typeof import('../main/cli/adapters/base-cli-process-utils')>(),
  killProcessGroup: (pid: number | undefined, signal: string) => mocks.kill(pid, signal),
}));

import { RemoteCliAdapter } from '../main/cli/adapters/remote-cli-adapter';
import { CodexCliAdapter } from '../main/cli/adapters/codex-cli-adapter';
import { createMockProcess, queueCodexRun, type MockChildProcess } from '../main/cli/adapters/codex-cli-adapter.test-helpers';
import { LocalInstanceManager } from './local-instance-manager';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import { wireInstanceEvents } from './worker-event-wiring';
import { COORDINATOR_TO_NODE_PARAM_SCHEMAS } from '../main/remote-node/rpc-schemas';

vi.setConfig({ testTimeout: 15_000 });

const READY_RUN = [
  '{"type":"thread.started","thread_id":"thread-ready"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"READY"}}',
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}',
];

describe('remote Codex exec-mode turn over the worker wire', () => {
  let registry: EventEmitter;
  let manager: LocalInstanceManager;
  let native: CodexCliAdapter;
  let spawnProcess: MockInstance<(args: string[]) => ChildProcess>;
  let remote: RemoteCliAdapter;
  let exitNotifications: ReturnType<typeof vi.fn>;
  let remoteExits: ReturnType<typeof vi.fn>;
  let remoteStatuses: string[];
  let remoteOutputs: { type: string; content: string }[];

  beforeEach(async () => {
    mocks.kill.mockReset();
    registry = new EventEmitter(); registryHolder.value = registry;
    // Exec mode, as on windows-pc: no app-server, one process per turn.
    native = new CodexCliAdapter({ workingDir: '/tmp/project' });
    Object.assign(native, { useAppServer: false });
    vi.spyOn(native, 'spawn').mockImplementation(async () => { Object.assign(native, { isSpawned: true }); return 1; });
    spawnProcess = vi.spyOn(native as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
    mocks.adapter = native;

    manager = new LocalInstanceManager(['/tmp']);
    exitNotifications = vi.fn();
    const emit = (event: string, payload: object): boolean => registry.emit(event, { nodeId: 'worker', ...payload });
    // Same mapping the coordinator's RPC router performs for each notification.
    wireInstanceEvents(manager, new EventEmitter(), {
      sendHeartbeatNotification: (instanceId: string) => emit('remote:instance-heartbeat', { instanceId }),
      sendOutputNotification: (instanceId: string, message: unknown) => emit('remote:instance-output', { instanceId, message }),
      sendCompleteNotification: (instanceId: string, response: unknown) => emit('remote:instance-complete', { instanceId, response }),
      sendContextNotification: (instanceId: string, usage: unknown) => emit('remote:instance-context', { instanceId, usage }),
      sendStateChange: (instanceId: string, state: string, info?: unknown) => emit('remote:instance-state-change', { instanceId, state, info }),
      sendPermissionRequest: (instanceId: string, permission: unknown) => emit('remote:instance-permission-request', { instanceId, permission }),
      sendExit: (instanceId: string, info: unknown) => {
        exitNotifications(instanceId, info);
        emit('remote:instance-state-change', { instanceId, state: 'exited', info });
      },
      sendTelemetryNotification: vi.fn(),
    } as unknown as WorkerInstanceNotifier);

    let result: unknown; let failure: Error | undefined;
    const dispatcher = new WorkerRpcDispatcher({ config: {} as never, instanceManager: manager,
      getFilesystemHandler: () => ({}) as never, getSyncHandler: () => ({}) as never,
      getTerminalHandler: () => ({}) as never, applyConfigUpdate: vi.fn() as never,
      getCdpTunnel: () => ({}) as never, stopManagedBrowser: vi.fn(), localAiHealth: {} as never,
      sendResult: (_id, value) => { result = value; }, sendError: (_id, code, message) => { failure = Object.assign(new Error(message), { code }); },
    });
    const sendRpc = vi.fn(async (_node: string, method: string, params: unknown) => {
      const schema = COORDINATOR_TO_NODE_PARAM_SCHEMAS[method];
      if (!schema) throw new Error(`Missing RPC schema for ${method}`);
      let callResult: unknown; let callFailure: Error | undefined;
      result = undefined; failure = undefined;
      await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 1, method, scope: 'instance', params: schema.parse(JSON.parse(JSON.stringify(params))) });
      callResult = result; callFailure = failure;
      if (callFailure) throw callFailure;
      return callResult;
    });
    remote = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer,
      'worker', 'codex', { sessionId: 'remote-codex', workingDirectory: '/tmp/project' });
    remoteExits = vi.fn(); remoteStatuses = []; remoteOutputs = [];
    remote.on('exit', remoteExits);
    remote.on('status', (status: string) => remoteStatuses.push(status));
    remote.on('output', (message: { type: string; content: string }) => remoteOutputs.push({ type: message.type, content: message.content }));
    await remote.spawn();
  });

  afterEach(async () => { remote.forceCleanup(); await manager.terminateAll(); vi.restoreAllMocks(); });

  it('completes a one-shot turn without reporting a process exit, and the session takes a second turn', async () => {
    queueCodexRun(spawnProcess, { stdoutLines: READY_RUN, code: 0 });
    await remote.sendInput('Reply with just the word READY.');

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(remoteOutputs.filter((message) => message.type === 'assistant').map((message) => message.content)).toEqual(['READY']);
    expect(remoteStatuses.at(-1)).toBe('idle');
    expect(exitNotifications).not.toHaveBeenCalled();
    expect(remoteExits).not.toHaveBeenCalled();
    expect(remote.isRunning()).toBe(true);
    expect(manager.getInstance('remote-codex')).toBeDefined();

    queueCodexRun(spawnProcess, { stdoutLines: READY_RUN, code: 0 });
    await remote.sendInput('And again.');
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(remoteExits).not.toHaveBeenCalled();
    expect(remoteStatuses.at(-1)).toBe('idle');
  });

  it('surfaces a crashed exec turn as a failed turn (as locally) rather than a session exit', async () => {
    queueCodexRun(spawnProcess, { stderrLines: ['fatal: provider process crashed'], code: 1 });

    await expect(remote.sendInput('Reply with just the word READY.')).rejects.toThrow();

    expect(remoteOutputs.some((message) => message.type === 'error')).toBe(true);
    expect(remoteExits).not.toHaveBeenCalled();
    expect(manager.getInstance('remote-codex')).toBeDefined();
  });

  it('settles an interrupted exec turn to idle without a process exit or respawn', async () => {
    let child: MockChildProcess | undefined;
    spawnProcess.mockImplementationOnce(() => {
      child = createMockProcess();
      return child as unknown as ChildProcess;
    });
    mocks.kill.mockImplementation((_pid, signal) => {
      setTimeout(() => {
        child!.stdout.end(); child!.stderr.end();
        child!.emitClose(null, signal);
      }, 0);
      return true;
    });

    const turn = remote.sendInput('Write a long essay.').catch((error: unknown) => error);
    await vi.waitFor(() => expect(child).toBeDefined());
    remoteStatuses.length = 0;

    const interrupt = remote.interrupt();
    expect(interrupt.status).toBe('accepted');
    await vi.waitFor(() => expect(remoteStatuses).toContain('idle'));

    expect(mocks.kill).toHaveBeenCalledWith(99999, 'SIGINT');
    expect(await turn).toBeInstanceOf(Error);
    expect(remoteExits).not.toHaveBeenCalled();
    expect(exitNotifications).not.toHaveBeenCalled();
    expect(manager.getInstance('remote-codex')?.lastStatus).toBe('idle');
  });

  it('still forwards the exit when a resident (app-server) Codex session dies', () => {
    // A resident session's exit is a real crash; the coordinator must recover it.
    Object.assign(native, { useAppServer: true });
    native.emit('exit', 1, null);

    expect(exitNotifications).toHaveBeenCalledWith('remote-codex', { code: 1, signal: null });
    expect(remoteExits).toHaveBeenCalledWith(1, null);
    expect(manager.getInstance('remote-codex')).toBeUndefined();
  });
});
