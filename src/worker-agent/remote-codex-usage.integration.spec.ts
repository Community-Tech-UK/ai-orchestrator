import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerNodeConnectionServer } from '../main/remote-node/worker-node-connection';
import type { WorkerNodeRegistry } from '../main/remote-node/worker-node-registry';
import type { RpcNotification, RpcRequest } from '../main/remote-node/worker-node-rpc';
import type { UnifiedSpawnOptions } from '../main/cli/adapters/adapter-factory.types';
import type { CodexCliConfig } from '../main/cli/adapters/codex-adapter-config';
import type { CodexEphemeralUsage } from '../shared/types/codex-ephemeral-usage.types';
import { DEFAULT_SETTINGS } from '../shared/types/settings.types';

const fixture = vi.hoisted(() => ({ directory: '', connection: undefined as unknown, registry: undefined as unknown, authenticated: true }));
vi.mock('electron', () => ({ app: { getPath: () => {
  if (!fixture.directory) throw new Error('Scratch directory unavailable');
  return fixture.directory;
} } }));
vi.mock('../main/core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => undefined,
  getAll: () => ({ providerAccountProfiles: [], providerAccountPools: {} }) }) }));
vi.mock('../main/remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => fixture.registry }));
vi.mock('../main/remote-node/worker-node-connection', () => ({ getWorkerNodeConnectionServer: () => fixture.connection }));
vi.mock('../main/auth/remote-auth', () => ({ getRemoteAuthService: () => ({ validateSessionToken: () => fixture.authenticated }) }));
vi.mock('../main/logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import * as factory from '../main/cli/adapters/adapter-factory';
import { RemoteCliAdapter } from '../main/cli/adapters/remote-cli-adapter';
import { ProviderRuntimeService } from '../main/providers/provider-runtime-service';
import { ProviderRuntimeRegistry } from '../main/providers/provider-runtime-registry';
import { InstanceSpawnParamsSchema } from '../main/remote-node/rpc-schemas';
import { InstanceTelemetryParamsSchema } from '../main/remote-node/instance-telemetry-rpc';
import { RpcEventRouter } from '../main/remote-node/rpc-event-router';
import { LocalInstanceManager } from './local-instance-manager';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import { wireInstanceEvents } from './worker-event-wiring';
import { WorkerInstanceNotifier } from './worker-instance-notifier';
import { WorkerStreamDurability } from './worker-stream-durability';
import { readCodexEphemeralUsage } from '../main/core/system/codex-ephemeral-usage-store';
import { CodexEphemeralUsageTracker } from '../main/cli/adapters/codex/ephemeral-usage';
import { CodexUsageAccounting } from '../main/cli/adapters/codex/usage-accounting';
import { codexExecUsage } from '../main/cli/adapters/codex/exec-ephemeral-usage';
import type { CodexCliAdapter } from '../main/cli/adapters/codex-cli-adapter';
import { createMockProcess } from '../main/cli/adapters/codex-cli-adapter.test-helpers';

const owner = 'owning-chat-placeholder';
const wireId = 'provider-session-placeholder';
const trialKey = 'GROUPING_ONLY_DO_NOT_LOG';
const jobId = 'queue-job-placeholder';
const options: UnifiedSpawnOptions = { instanceId: owner, sessionId: wireId, jobId, sessionKind: 'plan-queue',
  trialKey, trialArm: 'candidate', ephemeral: true, workingDirectory: '/tmp' };
const unused = (): never => { throw new Error('Unexpected external dependency'); };

describe('remote Codex ownership and final numeric receipts over authenticated worker transport', () => {
  let manager: LocalInstanceManager;
  let remote: RemoteCliAdapter;
  let registry: EventEmitter & { getNode: () => unknown };
  let connection: EventEmitter & { sendRpc: ReturnType<typeof vi.fn>; sendNotification: ReturnType<typeof vi.fn>; sendResponse: ReturnType<typeof vi.fn> };
  let router: RpcEventRouter;
  let notifier: WorkerInstanceNotifier;
  let frames: (RpcNotification | RpcRequest)[];
  let spawns: Record<string, unknown>[];
  let workerOptions: UnifiedSpawnOptions;
  let workerConfig: CodexCliConfig;
  let native: CodexCliAdapter;
  let legacyWorker: boolean;
  let modernCapability: boolean;
  let failSpawn: boolean;
  let onTerminate: () => void;
  let lateFinalize: (() => void) | undefined;

  beforeEach(() => {
    fixture.directory = mkdtempSync(join(tmpdir(), 'aio-remote-codex-usage-'));
    fixture.authenticated = true; frames = []; spawns = []; legacyWorker = false; modernCapability = true; failSpawn = false;
    onTerminate = () => undefined; lateFinalize = undefined;
    registry = Object.assign(new EventEmitter(), { getNode: () => ({ capabilities: modernCapability ? { codexSpawnMetadata: 1 } : {} }) });
    fixture.registry = registry;
    manager = new LocalInstanceManager(['/tmp']);
    const original = factory.createCliAdapter;
    vi.spyOn(factory, 'createCliAdapter').mockImplementation((cli, spawnOptions, location) => {
      const adapter = original(cli, spawnOptions, location);
      if (!location || location.type === 'local') {
        workerOptions = spawnOptions;
        workerConfig = (adapter as unknown as { cliConfig: CodexCliConfig }).cliConfig;
        native = adapter as CodexCliAdapter;
        // Isolate only provider startup/termination. Factory, metadata, receipt
        // accounting, schema, dispatcher, notifier and controller store are real.
        vi.spyOn(adapter, 'spawn').mockImplementation(async () => {
          if (failSpawn) throw new Error('Synthetic startup refusal');
          Object.assign(adapter, { isSpawned: true, useAppServer: false }); return 1;
        });
        vi.spyOn(adapter, 'terminate').mockImplementation(async () => onTerminate());
      }
      return adapter;
    });
    let result: unknown;
    let failure: Error | undefined;
    const dispatcher = new WorkerRpcDispatcher({ config: {} as never, instanceManager: manager,
      getFilesystemHandler: unused, getSyncHandler: unused, getTerminalHandler: unused, applyConfigUpdate: unused,
      getCdpTunnel: unused, stopManagedBrowser: unused, localAiHealth: {} as never,
      sendResult: (_id, value) => { result = value; }, sendError: (_id, _code, message) => { failure = new Error(message); },
    });
    connection = Object.assign(new EventEmitter(), { sendNotification: vi.fn(), sendResponse: vi.fn(),
      sendRpc: vi.fn(async (_node: string, method: string, params: Record<string, unknown>) => {
        const wire = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
        if (method === 'instance.spawn') {
          if (legacyWorker) for (const field of ['owningInstanceId', 'jobId', 'sessionKind', 'trialKey', 'trialArm', 'ephemeral', 'codexUsageProtocol']) delete wire[field];
          spawns.push(wire);
        }
        result = undefined; failure = undefined;
        await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 1, method, scope: 'instance', params: wire });
        if (failure) throw failure;
        return result;
      }),
    });
    fixture.connection = connection;
    router = new RpcEventRouter(connection as unknown as WorkerNodeConnectionServer, registry as unknown as WorkerNodeRegistry);
    router.start();
    const socket = { readyState: 1, send(data: string, done?: () => void) {
      const frame = JSON.parse(data) as RpcNotification | RpcRequest;
      frames.push(frame);
      connection.emit('id' in frame ? 'rpc:request' : 'rpc:notification', 'worker-placeholder', frame);
      done?.();
    } } as unknown as WebSocket;
    notifier = new WorkerInstanceNotifier({ getSocket: () => socket, getToken: () => undefined, durability: new WorkerStreamDurability() });
    wireInstanceEvents(manager, new EventEmitter(), notifier);
    remote = makeRemote(options);
  });

  afterEach(async () => {
    remote?.forceCleanup(); await manager.terminateAll(); notifier.flushOutputBuffer(); router.stop();
    vi.restoreAllMocks(); rmSync(fixture.directory, { recursive: true, force: true }); fixture.directory = '';
  });

  function makeRemote(spawnOptions: UnifiedSpawnOptions): RemoteCliAdapter {
    const runtime = new ProviderRuntimeService({ registry: new ProviderRuntimeRegistry(),
      settings: { get: key => ({ ...DEFAULT_SETTINGS, enableSpawnWorkerOffload: true })[key] } });
    const adapter = runtime.createAdapter({ cliType: 'codex', options: spawnOptions, executionLocation: { type: 'remote', nodeId: 'worker-placeholder' } });
    expect(adapter).toBeInstanceOf(RemoteCliAdapter); // Executing placement guard, not an assumption.
    return adapter as RemoteCliAdapter;
  }
  function finish(exec = false): void {
    if (exec) {
      const tracker = codexExecUsage(workerConfig);
      tracker.observe({ type: 'thread.started', thread_id: 'exec-thread-placeholder' });
      tracker.observe({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 7, output_tokens: 5, reasoning_output_tokens: 2 } });
      lateFinalize = () => tracker.finish();
    } else {
      const accounting = new CodexUsageAccounting();
      const tracker = new CodexEphemeralUsageTracker(workerConfig, accounting);
      tracker.bind('native-thread-placeholder');
      accounting.fallback('native-thread-placeholder', { input_tokens: 20, cached_input_tokens: 7, output_tokens: 5, reasoning_output_tokens: 2 }, false);
      lateFinalize = () => tracker.finish('stopped');
    }
    lateFinalize();
  }
  function usageFrames() { return frames.filter(frame => frame.method === 'instance.telemetry'); }
  function entries() { return readCodexEphemeralUsage().entries; }
  function forged(receipt: unknown, overrides: Record<string, unknown> = {}): void {
    const wire = spawns[0];
    connection.emit('rpc:notification', 'worker-placeholder', { jsonrpc: '2.0', method: 'instance.telemetry', params: {
      instanceId: wireId, telemetry: { event: 'codex_ephemeral_usage', payload: { interactionId: wire['interactionId'], receipt } }, ...overrides,
    } });
  }

  it('keeps semantic owner independent of provider wire identity through schema and real factory', async () => {
    await remote.spawn();
    expect(InstanceSpawnParamsSchema.parse(spawns[0])).toMatchObject({ instanceId: wireId, owningInstanceId: owner,
      jobId, sessionKind: 'plan-queue', trialKey, trialArm: 'candidate', ephemeral: true, codexUsageProtocol: 1 });
    expect(workerOptions).toMatchObject({ instanceId: owner, sessionId: wireId, jobId, sessionKind: 'plan-queue', trialKey, trialArm: 'candidate', ephemeral: true });
    expect(workerConfig).toMatchObject({ instanceId: owner, sessionId: wireId, jobId, sessionKind: 'plan-queue', trialKey, trialArm: 'candidate', ephemeral: true });
  });
  it.each([false, true])('ingests the real final tracker receipt into the controller reader once (exec=%s)', async exec => {
    await remote.spawn(); finish(exec); lateFinalize!();
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ instanceId: owner, jobId, kind: 'plan-queue', trialArm: 'candidate',
      trialKey: createHash('sha256').update(trialKey).digest('hex'), tokens: { input: 20, cache: 7, output: 5, reasoning: 2, total: 25 } });
    expect(usageFrames()).toHaveLength(1);
    expect(InstanceTelemetryParamsSchema.safeParse(usageFrames()[0].params).success).toBe(true);
    const raw = readFileSync(join(fixture.directory, 'logs/codex-ephemeral-usage.jsonl'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    expect(raw).not.toContain(trialKey);
    expect(JSON.stringify(usageFrames())).not.toContain(trialKey);
    notifier.replayDurableEvents([{ instanceId: wireId, afterSeq: 0 }]);
    forged(entries()[0]); // A second live frame with no durable seq must also dedupe.
    expect(readFileSync(join(fixture.directory, 'logs/codex-ephemeral-usage.jsonl'), 'utf8')).toBe(raw);
  });
  it('forwards explicit persistent false and produces no ephemeral receipt', async () => {
    remote.forceCleanup(); remote = makeRemote({ ...options, ephemeral: false, sessionKind: 'loop' });
    await remote.spawn(); expect(workerConfig.ephemeral).toBe(false);
    finish(); finish(true); await remote.terminate();
    expect(usageFrames()).toEqual([]); expect(entries()).toEqual([]);
  });
  it('collects an actual factory-created exec adapter turn through worker sendInput and its final writer', async () => {
    await remote.spawn();
    const child = createMockProcess();
    const spawnProcess = vi.spyOn(native as unknown as { spawnProcess: () => typeof child }, 'spawnProcess').mockReturnValue(child);
    const pending = remote.sendInput('DO_NOT_RECORD');
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true));
    for (const event of [{ type: 'thread.started', thread_id: 'actual-exec-thread' },
      { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 7, output_tokens: 5 } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'DO_NOT_RECORD' } }]) child.stdout.write(JSON.stringify(event) + '\n');
    child.stdout.end(); child.stderr.end(); child.emitClose(0);
    await pending;
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(entries()).toMatchObject([{ threadId: 'actual-exec-thread', instanceId: owner, jobId, kind: 'plan-queue',
      tokens: { input: 20, cache: 7, output: 5, reasoning: null, total: 25 }, finishReason: 'exec-exit' }]);
    expect(JSON.stringify(usageFrames())).not.toContain('DO_NOT_RECORD');
    expect(JSON.stringify(entries())).not.toContain('DO_NOT_RECORD');
    await remote.terminate(); expect(entries()).toHaveLength(1);
  });
  it('finalizes the adapter-owned native tracker during its real terminate path', async () => {
    await remote.spawn();
    const access = native as unknown as { ephemeralUsage: CodexEphemeralUsageTracker; usageAccounting: CodexUsageAccounting };
    access.ephemeralUsage.bind('adapter-native-thread');
    access.usageAccounting.fallback('adapter-native-thread', { input_tokens: 20, cached_input_tokens: 7, output_tokens: 5 }, false);
    vi.mocked(native.terminate).mockRestore();
    await remote.terminate();
    expect(entries()).toMatchObject([{ threadId: 'adapter-native-thread', instanceId: owner, jobId, kind: 'plan-queue', finishReason: 'stopped' }]);
    access.ephemeralUsage.finish('runtime-exit'); expect(entries()).toHaveLength(1);
  });
  it('refuses persistent Codex on a worker that cannot preserve explicit false, before any RPC', async () => {
    modernCapability = false; remote.forceCleanup(); remote = makeRemote({ ...options, ephemeral: false });
    await expect(remote.spawn()).rejects.toThrow(/worker/i); expect(spawns).toEqual([]);
  });
  it('lets older workers run ordinary ephemeral jobs without fabricating receipts', async () => {
    modernCapability = false; legacyWorker = true;
    await remote.spawn(); finish();
    expect(manager.getInstance(wireId)).toBeDefined(); expect(usageFrames()).toEqual([]); expect(entries()).toEqual([]);
  });
  it('accepts finalization during stop, then rejects late callbacks and removes listeners', async () => {
    await remote.spawn(); onTerminate = () => { finish(); lateFinalize!(); };
    await remote.terminate(); expect(entries()).toHaveLength(1);
    const receipt = entries()[0];
    forged({ ...receipt, threadId: 'late-thread-placeholder' }); finish(true);
    expect(entries()).toHaveLength(1); expect(registry.eventNames()).toEqual([]);
  });
  it('retains receipt ownership after a refused stop until the actual retry finalizes', async () => {
    await remote.spawn(); onTerminate = () => { throw new Error('Synthetic stop refusal'); };
    await expect(remote.terminate()).rejects.toThrow('Synthetic stop refusal');
    expect(remote.getRemoteInstanceId()).toBe(wireId);
    onTerminate = () => finish();
    await remote.terminate(); expect(entries()).toHaveLength(1);
    expect(registry.eventNames()).toEqual([]);
  });
  it('rejects malformed, unauthenticated, foreign-owner/job/hash and stale-incarnation receipts', async () => {
    await remote.spawn(); finish(); const receipt = entries()[0] as CodexEphemeralUsage;
    expect(receipt).toBeDefined();
    for (const change of [{ instanceId: wireId }, { jobId: 'foreign-job' }, { kind: 'chat' }, { trialKey: 'a'.repeat(64) },
      { trialArm: 'control' }, { tokens: { ...receipt.tokens, input: -1 } }, { content: 'DO_NOT_RECORD' }, { path: '/worker/private' }]) {
      forged({ ...receipt, threadId: 'forged-thread-placeholder', ...change });
    }
    forged({ ...receipt, threadId: 'foreign-wire-placeholder' }, { instanceId: 'another-session' });
    fixture.authenticated = false; forged({ ...receipt, threadId: 'unauthenticated-placeholder' }); fixture.authenticated = true;
    registry.emit('remote:instance-telemetry', { nodeId: 'foreign-worker', instanceId: wireId,
      telemetry: { event: 'codex_ephemeral_usage', payload: { interactionId: spawns[0]['interactionId'], receipt: { ...receipt, threadId: 'foreign-node' } } } });
    forged(receipt, { telemetry: { event: 'codex_ephemeral_usage', payload: { interactionId: 'old-incarnation', receipt: { ...receipt, threadId: 'stale' } } } });
    expect(entries()).toEqual([receipt]);
  });
  it('retains controller ownership after refused startup until stop confirms absence, without fabricating receipts', async () => {
    failSpawn = true; await expect(remote.spawn()).rejects.toThrow('Synthetic startup refusal');
    finish(); expect(entries()).toEqual([]); expect(usageFrames()).toEqual([]);
    expect(remote.getRemoteInstanceId()).toBe(wireId);
    await remote.terminate(false);
    expect(connection.sendRpc).toHaveBeenLastCalledWith('worker-placeholder', 'instance.terminate', { instanceId: wireId });
    expect(remote.getRemoteInstanceId()).toBeNull(); expect(registry.eventNames()).toEqual([]);
  });
  it.each(['exit', 'forceCleanup'] as const)('removes the added receipt observer on %s', async ending => {
    await remote.spawn();
    if (ending === 'exit') remote.handleRemoteExit(0, null); else remote.forceCleanup();
    finish(); expect(entries()).toEqual([]); expect(registry.eventNames()).toEqual([]);
  });
  it('retains honestly missing ownership without substituting the wire provider session', async () => {
    remote.forceCleanup(); remote = makeRemote({ sessionId: wireId, workingDirectory: '/tmp' });
    await remote.spawn(); finish(true);
    expect(entries()).toMatchObject([{ instanceId: null, jobId: null, kind: 'chat', trialKey: null, trialArm: 'unassigned' }]);
  });
  it('validates new metadata without requiring it from older controllers', () => {
    const base = { instanceId: wireId, cliType: 'codex', workingDirectory: '/tmp' };
    expect(InstanceSpawnParamsSchema.safeParse(base).success).toBe(true);
    for (const invalid of [{ owningInstanceId: '../path' }, { jobId: '' }, { sessionKind: 'invented' }, { trialArm: 'invented' },
      { trialKey: 'x'.repeat(4097) }, { ephemeral: 'false' }, { codexUsageProtocol: 2 }]) {
      expect(InstanceSpawnParamsSchema.safeParse({ ...base, ...invalid }).success).toBe(false);
    }
  });
});
