import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { CliResponse } from '../../main/cli/adapters/base-cli-adapter.types';
import type { WorkerNodeConnectionServer } from '../../main/remote-node/worker-node-connection';
import type { WorkerNodeRegistry } from '../../main/remote-node/worker-node-registry';
import type { RpcNotification, RpcRequest } from '../../main/remote-node/worker-node-rpc';

const registry = Object.assign(new EventEmitter(), { getNode: () => ({}) });
const mocks = vi.hoisted(() => ({ createAdapter: vi.fn() }));
vi.mock('../../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: mocks.createAdapter }));
vi.mock('../../main/remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registry }));
vi.mock('../../main/auth/remote-auth', () => ({ getRemoteAuthService: () => ({ validateSessionToken: () => true }) }));
vi.mock('../../main/logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { RemoteCliAdapter } from '../../main/cli/adapters/remote-cli-adapter';
import { deferResponseUsage, deferUntilResponseUsageSettled } from '../../main/cli/adapters/deferred-response-usage';
import { InstanceCompleteParamsSchema, InstanceSpawnParamsSchema } from '../../main/remote-node/rpc-schemas';
import { RpcEventRouter } from '../../main/remote-node/rpc-event-router';
import { LocalInstanceManager } from '../local-instance-manager';
import { WorkerRpcDispatcher } from '../worker-rpc-dispatcher';
import { wireInstanceEvents } from '../worker-event-wiring';
import { WorkerInstanceNotifier } from '../worker-instance-notifier';
import { WorkerStreamDurability } from '../worker-stream-durability';

class FixtureAdapter extends EventEmitter {
  spawn = vi.fn(async () => 1);
  sendInput = vi.fn(async () => undefined);
  terminate = vi.fn(async () => undefined);
  interrupt = vi.fn(async () => undefined);
}

const baseSpawn = { instanceId: 'protocol-instance', cliType: 'claude', workingDirectory: '/tmp' };
const unusedDependency = (): never => { throw new Error('Unexpected protocol fixture dependency'); };
type PeerMode = 'current' | 'legacy-controller' | 'legacy-worker';

describe('explicit per-instance remote usage settlement negotiation', () => {
  let mode: PeerMode;
  let manager: LocalInstanceManager;
  let adapter: FixtureAdapter;
  let remote: RemoteCliAdapter;
  let router: RpcEventRouter;
  let notifier: WorkerInstanceNotifier;
  let durability: WorkerStreamDurability;
  let dispatcher: WorkerRpcDispatcher;
  let frames: (RpcNotification | RpcRequest)[];
  let spawns: Record<string, unknown>[];
  let responses: CliResponse[];
  let booked: number[];
  let sourceCompletions: unknown[][];

  beforeEach(() => {
    mode = 'current'; frames = []; spawns = []; responses = []; booked = []; sourceCompletions = [];
    registry.removeAllListeners();
    adapter = new FixtureAdapter(); mocks.createAdapter.mockReturnValue(adapter);
    manager = new LocalInstanceManager(['/tmp']);
    manager.on('instance:complete', (...args: unknown[]) => sourceCompletions.push(args));
    dispatcher = new WorkerRpcDispatcher({
      config: { nodeId: 'worker-placeholder', name: 'Fixture', authToken: 'AUTH_TOKEN_PLACEHOLDER',
        namespace: 'fixture', maxConcurrentInstances: 10, workingDirectories: ['/tmp'], reconnectIntervalMs: 1000, heartbeatIntervalMs: 1000 },
      instanceManager: manager, getFilesystemHandler: unusedDependency, getSyncHandler: unusedDependency,
      getTerminalHandler: unusedDependency, applyConfigUpdate: unusedDependency, getCdpTunnel: unusedDependency,
      stopManagedBrowser: unusedDependency, sendResult: vi.fn(),
      sendError: (_id, _code, message) => { throw new Error(message); },
    });
    const connection = Object.assign(new EventEmitter(), {
      sendNotification: vi.fn(), sendResponse: vi.fn(),
      sendRpc: vi.fn(async (_node: string, method: string, params: Record<string, unknown>) => {
        if (method !== 'instance.spawn') return { cursors: [] };
        const wire = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
        // Older controllers omit the opt-in; older worker z.object schemas
        // strip the unknown opt-in before passing their parsed spawn onward.
        if (mode === 'legacy-controller') delete wire['usageSettlementProtocol'];
        const parsed = mode === 'legacy-worker'
          ? InstanceSpawnParamsSchema.omit({ usageSettlementProtocol: true }).parse(wire)
          : wire;
        spawns.push(parsed);
        await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 1, method, scope: 'instance', params: parsed });
        return { instanceId: baseSpawn.instanceId };
      }),
    });
    router = new RpcEventRouter(connection as unknown as WorkerNodeConnectionServer, registry as unknown as WorkerNodeRegistry);
    router.start(); durability = new WorkerStreamDurability();
    const socket = { readyState: 1, send(data: string, done?: () => void) {
      const frame = JSON.parse(data) as RpcNotification | RpcRequest;
      frames.push(frame);
      connection.emit('id' in frame ? 'rpc:request' : 'rpc:notification', 'worker-placeholder', frame);
      done?.();
    } } as unknown as WebSocket;
    notifier = new WorkerInstanceNotifier({ getSocket: () => socket, getToken: () => undefined, durability });
    wireInstanceEvents(manager, new EventEmitter(), notifier);
    remote = new RemoteCliAdapter(connection as unknown as WorkerNodeConnectionServer, 'worker-placeholder', 'claude',
      { sessionId: baseSpawn.instanceId, workingDirectory: '/tmp' });
    remote.on('complete', (response: CliResponse) => {
      responses.push(response);
      const book = () => booked.push(response.usage?.cost ?? 0);
      if (!deferUntilResponseUsageSettled(response, book)) book();
    });
  });

  afterEach(async () => {
    remote.forceCleanup(); await manager.terminateAll(); notifier.flushOutputBuffer(); router.stop(); vi.restoreAllMocks();
  });

  const earlyResponse = (): CliResponse => ({ id: 'failed-turn', role: 'assistant', content: 'Partial reply',
    usage: { inputTokens: 100, outputTokens: 20 }, metadata: { turnErrored: true } });
  function completions(): CliResponse[] {
    return frames.filter(frame => frame.method === 'instance.complete').map(frame => (frame.params as { response: CliResponse }).response);
  }

  it('preserves only the supported opt-in through the actual spawn validator', () => {
    expect(InstanceSpawnParamsSchema.parse({ ...baseSpawn, usageSettlementProtocol: 1 }).usageSettlementProtocol).toBe(1);
    expect(InstanceSpawnParamsSchema.parse(baseSpawn)).not.toHaveProperty('usageSettlementProtocol');
    for (const invalid of [0, 2, '1', true, null, {}]) {
      expect(InstanceSpawnParamsSchema.safeParse({ ...baseSpawn, usageSettlementProtocol: invalid }).success).toBe(false);
    }
  });

  it('new controller and worker emit one semantic completion and settle its exact paid usage once', async () => {
    await remote.spawn();
    expect(spawns[0]['usageSettlementProtocol']).toBe(1);
    expect(manager.getInstance(baseSpawn.instanceId)?.spawnParams.usageSettlementProtocol).toBe(1);
    const response = earlyResponse(); const settle = deferResponseUsage(response);
    adapter.emit('complete', response);
    expect(sourceCompletions).toEqual([[baseSpawn.instanceId, response, true]]);
    expect(completions()).toHaveLength(1); expect(responses).toHaveLength(1); expect(booked).toEqual([]);
    expect(completions()[0].metadata?.['aioRemoteUsageSettlement']).toBe('pending');
    expect(responses[0].metadata).toEqual({ turnErrored: true });
    response.usage = { ...response.usage, cost: 0.25 };
    settle(); settle();
    expect(completions()).toHaveLength(2); expect(responses).toHaveLength(1); expect(booked).toEqual([0.25]);
    expect(completions()[1].metadata?.['aioRemoteUsageSettlement']).toBe('settled');
    expect(responses[0].usage?.cost).toBe(0.25);
    notifier.replayDurableEvents([{ instanceId: baseSpawn.instanceId, afterSeq: 0 }]);
    expect(responses).toHaveLength(1); expect(booked).toEqual([0.25]);
    expect(frames.filter(frame => frame.method === 'instance.complete').every(frame => InstanceCompleteParamsSchema.safeParse(frame.params).success)).toBe(true);
    expect(completions().every(value => !('usageSettlementProtocol' in value) && value.metadata?.['usageSettlementProtocol'] === undefined)).toBe(true);
  });

  it.each(['legacy-controller', 'legacy-worker'] as const)('%s retains one immediate unmarked completion through JSON transport', async peer => {
    mode = peer;
    if (peer === 'legacy-controller') {
      // Original controller forwarding contract: every remote complete frame
      // unconditionally runs semantic completion hooks.
      vi.spyOn(remote, 'handleRemoteComplete').mockImplementation(response => remote.emit('complete', response));
    }
    await remote.spawn();
    expect(spawns[0]).not.toHaveProperty('usageSettlementProtocol');
    expect(manager.getInstance(baseSpawn.instanceId)?.spawnParams.usageSettlementProtocol).toBeUndefined();
    const response = earlyResponse(); const settle = deferResponseUsage(response);
    adapter.emit('complete', response);
    expect(sourceCompletions).toEqual([[baseSpawn.instanceId, response, false]]);
    expect(completions()).toEqual([response]); expect(responses).toHaveLength(1); expect(booked).toEqual([0]);
    expect(completions()[0].metadata).toEqual({ turnErrored: true });
    response.usage = { ...response.usage, cost: 0.25 };
    settle(); settle();
    // The old wire contract cannot amend a bill after its early completion.
    expect(completions()).toHaveLength(1); expect(responses).toHaveLength(1); expect(booked).toEqual([0]);
    expect(responses[0].usage?.cost).toBeUndefined();
    adapter.emit('complete', { id: 'next-turn', role: 'assistant', content: 'Next reply', usage: { cost: 0.25 } });
    expect(completions()).toHaveLength(2); expect(responses).toHaveLength(2); expect(booked).toEqual([0, 0.25]);
    notifier.replayDurableEvents([{ instanceId: baseSpawn.instanceId, afterSeq: 0 }]);
    expect(responses).toHaveLength(2);
  });

  it('retains opt-in across worker hibernate and wake without adding it to provider options', async () => {
    await remote.spawn(); await manager.hibernate(baseSpawn.instanceId);
    adapter = new FixtureAdapter(); mocks.createAdapter.mockReturnValue(adapter);
    await manager.wake(baseSpawn.instanceId);
    const response = earlyResponse(); const settle = deferResponseUsage(response);
    adapter.emit('complete', response);
    expect(sourceCompletions.at(-1)).toEqual([baseSpawn.instanceId, response, true]);
    response.usage = { cost: 0.25 }; settle();
    expect(booked).toEqual([0.25]);
    expect(mocks.createAdapter.mock.calls.every(call => !('usageSettlementProtocol' in call[1]))).toBe(true);
  });
});
