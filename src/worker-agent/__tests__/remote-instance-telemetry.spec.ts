import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { CliAdapter } from '../../main/cli/adapters/adapter-factory';
import { createInitializedAgentHarness, TestAcpCliAdapter, type FakeAcpProcess } from '../../main/cli/adapters/acp-cli-adapter.test-helpers';
import { buildAcpSystemPromptBlock } from '../../main/cli/adapters/acp-system-prompt-delivery';
import { observeClaudeSubagentUsage, flushClaudeSubagentUsage } from '../../main/cli/adapters/claude-subagent-usage';
import { RemoteCliAdapter } from '../../main/cli/adapters/remote-cli-adapter';
import { _resetAllContextManifestsForTesting, recordContextManifest, getLatestContextManifest } from '../../main/context/context-manifest-store';
import { subscribeCostAttribution, type CostAttributionRecord } from '../../main/core/system/cost-attribution';
import { bindRawAdapterProviderEvents } from '../../main/instance/instance-communication-provider-events';
import { ProviderRuntimeRegistry } from '../../main/providers/provider-runtime-registry';
import { ProviderRuntimeService } from '../../main/providers/provider-runtime-service';
import { RpcEventRouter } from '../../main/remote-node/rpc-event-router';
import type { WorkerNodeConnectionServer } from '../../main/remote-node/worker-node-connection';
import type { WorkerNodeRegistry } from '../../main/remote-node/worker-node-registry';
import type { RpcNotification } from '../../main/remote-node/worker-node-rpc';
import type { Instance } from '../../shared/types/instance.types';
import { LocalInstanceManager, type SpawnParams } from '../local-instance-manager';
import { wireInstanceEvents } from '../worker-event-wiring';
import { WorkerInstanceNotifier } from '../worker-instance-notifier';
import { WorkerStreamDurability } from '../worker-stream-durability';

const auth = { allowed: true };
const registry = Object.assign(new EventEmitter(), { getNode: (id: string) => id === 'windows-pc' ? {} : undefined });
type WorkerAdapter = EventEmitter & { spawn(): Promise<number | void>; sendInput(message: string): Promise<void>; terminate(): Promise<void> };
let workerAdapter: WorkerAdapter;
vi.mock('../../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: () => workerAdapter }));
vi.mock('../../main/remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registry }));
vi.mock('../../main/auth/remote-auth', () => ({ getRemoteAuthService: () => ({ validateSessionToken: () => auth.allowed }) }));
vi.mock('../../main/pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false }) }));
vi.mock('../../main/logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

describe('actual remote instance telemetry transport', () => {
  let manager: LocalInstanceManager;
  let connection: EventEmitter & { sendRpc: ReturnType<typeof vi.fn>; sendNotification: ReturnType<typeof vi.fn> };
  let router: RpcEventRouter;
  let notifier: WorkerInstanceNotifier;
  let remote: RemoteCliAdapter;
  let proc: FakeAcpProcess | undefined;
  let socketOpen: boolean;
  let frames: RpcNotification[];
  let records: CostAttributionRecord[];
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    registry.removeAllListeners();
    _resetAllContextManifestsForTesting();
    auth.allowed = true;
    socketOpen = true;
    frames = [];
    records = [];
    unsubscribe = subscribeCostAttribution(record => records.push(record));
    manager = new LocalInstanceManager(['/tmp']);
    connection = Object.assign(new EventEmitter(), {
      sendNotification: vi.fn(),
      sendRpc: vi.fn(async (_node: string, method: string, params: SpawnParams & { message: string }) => {
        if (method === 'instance.spawn') { await manager.spawn(params); return { instanceId: params.instanceId }; }
        if (method === 'instance.sendInput') return manager.sendInput(params.instanceId, params.message);
        if (method === 'instance.terminate') return manager.terminate(params.instanceId);
        return { cursors: [] };
      }),
    });
    router = new RpcEventRouter(connection as unknown as WorkerNodeConnectionServer, registry as unknown as WorkerNodeRegistry);
    router.start();
    const socket = {
      get readyState() { return socketOpen ? 1 : 3; },
      send(data: string, done?: () => void) {
        const frame = JSON.parse(data) as RpcNotification;
        frames.push(frame);
        connection.emit('rpc:notification', 'windows-pc', frame);
        done?.();
      },
    } as unknown as WebSocket;
    notifier = new WorkerInstanceNotifier({ getSocket: () => socket, getToken: () => undefined, durability: new WorkerStreamDurability() });
    wireInstanceEvents(manager, new EventEmitter(), notifier);
  });

  afterEach(async () => {
    remote?.forceCleanup();
    await manager.terminateAll();
    proc?.exit();
    proc = undefined;
    notifier.flushOutputBuffer();
    router.stop();
    unsubscribe();
    vi.unstubAllEnvs();
  });

  function createRemote(cliType: SpawnParams['cliType'], systemPrompt?: string): void {
    remote = new RemoteCliAdapter(connection as unknown as WorkerNodeConnectionServer, 'windows-pc', cliType,
      { instanceId: 'controller-instance', sessionId: 'worker-instance', workingDirectory: '/tmp', systemPrompt });
  }

  it.each(['copilot', 'opencode', 'cursor', 'grok'] as const)('records actual %s cuts only after native accepted retry, once across replay', async cliType => {
    const systemPrompt = '# Rules\n' + 'a'.repeat(1000) + '\n# Omitted details\n' + 'b'.repeat(120000) + '\n# Permissions\nKeep permissions.';
    proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', request => proc!.respond(request.id, { stopReason: 'end_turn' }));
    workerAdapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', systemPrompt, systemPromptMaxChars: 1200 });
    createRemote(cliType, systemPrompt);
    recordContextManifest('controller-instance', 'spawn', []);
    new ProviderRuntimeService({ registry: new ProviderRuntimeRegistry(), createAdapter: () => remote as CliAdapter })
      .createAdapter({ cliType, options: { instanceId: 'controller-instance', systemPrompt }, executionLocation: { type: 'remote', nodeId: 'windows-pc' } });
    const delivered = vi.fn();
    remote.on('system_prompt_delivered', delivered);
    await remote.spawn();
    expect(getLatestContextManifest('controller-instance')?.note).toBeUndefined();
    const write = proc.stdin.write;
    proc.stdin.write = () => { throw new Error('Synthetic native write refusal'); };
    await expect(remote.sendInput('First')).rejects.toThrow('Synthetic native write refusal');
    expect(getLatestContextManifest('controller-instance')?.note).toBeUndefined();
    proc.stdin.write = write;
    await remote.sendInput('Retry');
    await remote.sendInput('Next');
    const { block: _block, ...actual } = buildAcpSystemPromptBlock(systemPrompt, 1200);
    expect(delivered).toHaveBeenCalledExactlyOnceWith(actual);
    expect(getLatestContextManifest('controller-instance')?.note).toBe(`ACP first message: delivered ${actual.deliveredChars} of ${actual.originalChars} characters; omitted sections: ${actual.omittedHeadings.join('; ')}.`);
    notifier.replayDurableEvents([{ instanceId: 'worker-instance', afterSeq: 0 }]);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(frames.filter(frame => frame.method === 'instance.telemetry'))).not.toContain(systemPrompt);
  });

  async function startClaude(finalKind: 'foreground' | 'background' = 'foreground'): Promise<void> {
    workerAdapter = Object.assign(new EventEmitter(), {
      spawn: async () => 123,
      sendInput: async () => {
        observeClaudeSubagentUsage(workerAdapter, { type: 'system', subtype: 'task_progress', tool_use_id: 'agent-tool',
          usage: { total_tokens: 100, tool_uses: 2, duration_ms: 300 }, description: 'excluded model text' });
        if (finalKind === 'foreground') flushClaudeSubagentUsage(workerAdapter);
        else observeClaudeSubagentUsage(workerAdapter, { type: 'system', subtype: 'task_notification', tool_use_id: 'agent-tool',
          usage: { totalTokens: 100, toolUses: 2, durationMs: 300 }, description: 'excluded model text' });
        workerAdapter.emit('complete', { content: 'OK' });
      },
      terminate: async () => undefined,
    });
    createRemote('claude');
    bindRawAdapterProviderEvents({ adapter: remote as CliAdapter, isStale: () => false, emit: vi.fn(),
      getInstance: () => ({ id: 'controller-instance', sessionId: 'controller-session' }) as Instance });
    await remote.spawn();
  }

  it.each([[false, 'foreground'], [true, 'foreground'], [false, 'background'], [true, 'background']] as const)
  ('records one final subagent, offline=%s, kind=%s, with parent identity and no descriptions', async (offline, kind) => {
    await startClaude(kind);
    socketOpen = !offline;
    await remote.sendInput('Work');
    if (offline) expect(records).toHaveLength(0);
    socketOpen = true;
    notifier.replayDurableEvents([{ instanceId: 'worker-instance', afterSeq: 0 }]);
    notifier.replayDurableEvents([{ instanceId: 'worker-instance', afterSeq: 0 }]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose: 'subagent', costSource: 'unknown', costKnown: false,
      instanceId: 'controller-instance', sessionId: 'controller-session', toolUseId: 'agent-tool', finalContextTokens: 100, toolUses: 2, durationMs: 300 });
    expect(JSON.stringify(records)).not.toContain('excluded model text');
    expect(JSON.stringify(frames.filter(frame => frame.method === 'instance.telemetry'))).not.toContain('description');
  });

  it('validates numeric-only telemetry, authentication, registered node and instance before delivery', async () => {
    await startClaude();
    const sample = { toolUseId: 'other-agent', finalContextTokens: 2, toolUses: 1, durationMs: 3, final: true };
    const frame = (payload: unknown, instanceId = 'worker-instance'): RpcNotification => ({ jsonrpc: '2.0', method: 'instance.telemetry',
      params: { instanceId, telemetry: { event: 'subagent_usage', payload } } });
    connection.emit('rpc:notification', 'windows-pc', frame({ ...sample, finalContextTokens: -1 }));
    connection.emit('rpc:notification', 'windows-pc', frame({ ...sample, description: 'forbidden' }));
    connection.emit('rpc:notification', 'unknown-node', frame(sample));
    connection.emit('rpc:notification', 'windows-pc', frame(sample, 'other-instance'));
    auth.allowed = false;
    connection.emit('rpc:notification', 'windows-pc', frame(sample));
    expect(records).toHaveLength(0);
    auth.allowed = true;
    connection.emit('rpc:notification', 'windows-pc', frame(sample));
    expect(records).toHaveLength(1);
  });

  it.each(['terminate', 'exit', 'failed-spawn'] as const)('removes worker and controller telemetry listeners on %s', async ending => {
    await startClaude();
    if (ending === 'failed-spawn') {
      await remote.terminate();
      workerAdapter.spawn = async () => { throw new Error('Synthetic spawn failure'); };
      await expect(remote.spawn()).rejects.toThrow('Synthetic spawn failure');
    } else if (ending === 'terminate') await remote.terminate();
    else {
      workerAdapter.emit('exit', 0, null);
      notifier.flushCriticalQueue();
      // Exit uses the RPC request path, unrelated to telemetry notifications.
      remote.handleRemoteExit(0, null);
    }
    expect(workerAdapter.listenerCount('subagent_usage')).toBe(0);
    expect(workerAdapter.listenerCount('system_prompt_delivered')).toBe(0);
    expect(registry.listenerCount('remote:instance-telemetry')).toBe(0);
  });
});
