import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { WorkerNodeConnectionServer } from '../remote-node/worker-node-connection';

const factory = vi.hoisted(() => vi.fn());
vi.mock('../cli/adapters/adapter-factory', () => ({ createCliAdapter: factory }));
const registry = Object.assign(new EventEmitter(), { getNode: () => ({ capabilities: { codexHelperPolicy: 1 } }) });
vi.mock('../remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registry }));
vi.mock('../pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false }) }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
import { RemoteCliAdapter } from '../cli/adapters/remote-cli-adapter';
import { LocalInstanceManager } from '../../worker-agent/local-instance-manager';
import { WorkerRpcDispatcher } from '../../worker-agent/worker-rpc-dispatcher';
import { sendInitialPromptToAdapter } from '../instance/lifecycle/initial-prompt-dispatch';
import { runAutomaticStartup } from '../work-admission/automatic-startup';
import { WorkAdmission } from '../work-admission/work-admission';
import { waitForRunOnNodeReadiness } from './run-on-node-readiness';

afterEach(() => { registry.removeAllListeners(); WorkAdmission._resetForTesting(); });

it('returns through real remote and worker dispatch while the fake provider first turn is still running', async () => {
  let finish!: () => void;
  const turn = new Promise<void>(resolve => { finish = resolve; });
  const provider = Object.assign(new EventEmitter(), {
    spawn: vi.fn(async () => 1), terminate: vi.fn(async () => undefined), interrupt: vi.fn(),
    sendInput: vi.fn(async () => { provider.emit('status', 'busy'); await turn; provider.emit('status', 'idle'); }),
  });
  factory.mockReturnValue(provider);
  const worker = new LocalInstanceManager(['/tmp']);
  worker.on('instance:stateChange', (instanceId, state, info) => {
    registry.emit('remote:instance-state-change', { nodeId: 'worker', instanceId, state, info });
  });
  const rpcTasks = new Set<Promise<void>>();
  const sendRpc = vi.fn(async (_node, method, params) => new Promise((resolve, reject) => {
    const dispatcher = new WorkerRpcDispatcher({ config: { workingDirectories: ['/tmp'] }, instanceManager: worker,
      sendResult: (_id, result) => resolve(result),
      sendError: (_id, _code, message) => reject(new Error(message)),
    } as ConstructorParameters<typeof WorkerRpcDispatcher>[0]);
    const task = dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 1, method, params });
    rpcTasks.add(task);
    void task.finally(() => rpcTasks.delete(task));
  }));
  const adapter = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer,
    'worker', 'codex', { sessionId: 'readiness-session', workingDirectory: '/tmp' });
  const manager = new EventEmitter();
  const instance = { id: 'coordinator-session', status: 'initializing', abortController: new AbortController() } as Instance;
  adapter.on('status', status => {
    instance.status = status;
    manager.emit('instance:state-changed', { instanceId: instance.id, status, instance });
  });
  let firstTurnFinished = false;
  try {
    await runAutomaticStartup(async startup => {
      instance.readyPromise = (async () => {
        await adapter.spawn(); instance.status = 'idle';
        await sendInitialPromptToAdapter(instance, adapter, 'Synthetic test task');
        firstTurnFinished = true;
      })();
      startup.register(instance, () => adapter.terminate());
      await waitForRunOnNodeReadiness(manager, instance, startup);
    });
    expect(instance.status).toBe('busy');
    expect(firstTurnFinished).toBe(false);
    expect(provider.sendInput).toHaveBeenCalledOnce();
    expect(sendRpc.mock.calls.map(call => call[1])).toEqual(['instance.spawn', 'instance.sendInput']);
    finish(); await instance.readyPromise;
    expect(instance.status).toBe('idle');
  } finally {
    finish(); await instance.readyPromise;
    await adapter.terminate(); await worker.terminateAll(); await Promise.all(rpcTasks);
  }
});
