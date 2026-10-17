import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import { adapterHasActiveProviderTurn, adapterHasActiveToolCalls, StuckProcessDetector } from '../../instance/stuck-process-detector';
import { RemoteCliAdapter } from './remote-cli-adapter';

const registry = new EventEmitter();
vi.mock('../../remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registry }));
vi.mock('../../pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false }) }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const detectors: StuckProcessDetector[] = [];
const adapters: RemoteCliAdapter[] = [];

async function setup() {
  const connected = vi.fn(() => true);
  const connection = { sendRpc: vi.fn().mockResolvedValue({ instanceId: 'remote-fixture' }), isNodeConnected: connected };
  const adapter = new RemoteCliAdapter(connection as unknown as WorkerNodeConnectionServer, 'worker-fixture', 'opencode', {
    instanceId: 'remote-fixture', sessionId: 'remote-fixture', workingDirectory: '/fixture',
  });
  adapters.push(adapter);
  await adapter.spawn();
  const spawnParams = connection.sendRpc.mock.calls.find(call => call[1] === 'instance.spawn')?.[2] as { interactionId: string };
  const detector = new StuckProcessDetector({
    isProcessAlive: () => adapter.isRunning(),
    hasActiveProviderTurn: () => adapterHasActiveProviderTurn(adapter),
    hasActiveToolCall: () => adapterHasActiveToolCalls(adapter),
    getTimeoutMultiplier: () => 1,
  });
  detectors.push(detector);
  detector.startTracking('remote-fixture');
  detector.updateState('remote-fixture', 'generating');
  const stuck = vi.fn();
  detector.on('process:stuck', stuck);
  const snapshot = (payload: unknown, overrides: Record<string, unknown> = {}, interactionId = spawnParams.interactionId) => registry.emit('remote:instance-state-change', {
    nodeId: 'worker-fixture', instanceId: 'remote-fixture', state: 'provider_turn', info: { interactionId, payload }, ...overrides,
  });
  return { adapter, connected, stuck, snapshot };
}

beforeEach(() => { vi.useFakeTimers(); registry.removeAllListeners(); });
afterEach(async () => {
  for (const detector of detectors.splice(0)) detector.shutdown();
  for (const adapter of adapters.splice(0)) await adapter.terminate(false);
  registry.removeAllListeners();
  vi.useRealTimers();
});

describe('remote OpenCode provider-turn lease and the controller stuck detector', () => {
  it('keeps a silent native turn alive beyond the generic eight-minute ceiling while worker proof renews', async () => {
    const { adapter, snapshot, stuck } = await setup();
    const renewal = setInterval(() => snapshot({ active: true, activeToolCalls: false }), 5_000);
    try {
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(adapter.hasActiveTurn()).toBe(true);
      expect(stuck).not.toHaveBeenCalled();
    } finally { clearInterval(renewal); }
  });

  it('allows normal stuck detection again when worker proof expires', async () => {
    const { adapter, snapshot, stuck } = await setup();
    snapshot({ active: true, activeToolCalls: false });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(adapter.hasActiveTurn()).toBe(false);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(stuck).toHaveBeenCalledOnce();
    expect(stuck).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'remote-fixture', state: 'generating' }));
  });

  it('does not treat worker processing status, malformed proof or another session as native turn ownership', async () => {
    const { adapter, snapshot, stuck } = await setup();
    snapshot({ active: true, activeToolCalls: false }, { state: 'processing' });
    snapshot({ active: true, activeToolCalls: false }, { nodeId: 'other-worker' });
    snapshot({ active: true, activeToolCalls: false }, { instanceId: 'other-instance' });
    snapshot({ active: true, activeToolCalls: false }, {}, 'other-incarnation');
    registry.emit('remote:instance-state-change', { nodeId: 'worker-fixture', instanceId: 'remote-fixture', state: 'provider_turn', info: { active: true, activeToolCalls: false } });
    snapshot({ active: false, activeToolCalls: true });
    snapshot({ active: 'true', activeToolCalls: false });
    expect(adapter.hasActiveTurn()).toBe(false);
    expect(adapter.hasActiveToolCalls()).toBe(false);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(stuck).toHaveBeenCalledOnce();
  });

  it('requires a connected worker and clears native ownership when the turn settles', async () => {
    const { adapter, connected, snapshot } = await setup();
    snapshot({ active: true, activeToolCalls: true });
    expect(adapter.hasActiveTurn()).toBe(true);
    expect(adapter.hasActiveToolCalls()).toBe(true);
    connected.mockReturnValue(false);
    expect(adapter.hasActiveTurn()).toBe(false);
    expect(adapter.hasActiveToolCalls()).toBe(false);
    connected.mockReturnValue(true);
    snapshot({ active: false, activeToolCalls: false });
    expect(adapter.hasActiveTurn()).toBe(false);
    snapshot({ active: true, activeToolCalls: true });
    registry.emit('remote:instance-state-change', { nodeId: 'worker-fixture', instanceId: 'remote-fixture', state: 'idle' });
    expect(adapter.hasActiveTurn()).toBe(false);
    expect(adapter.hasActiveToolCalls()).toBe(false);
  });
});
