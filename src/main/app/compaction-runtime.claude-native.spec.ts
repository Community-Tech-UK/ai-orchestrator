import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupCompactionCoordinator, setCompactionMarkerRecorderForTesting } from './compaction-runtime';
import { CompactionCoordinator } from '../context/compaction-coordinator';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import { ClaudeCliAdapter } from '../cli/adapters/claude-cli-adapter';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => 0, on: vi.fn() }) }));
vi.mock('../rlm/llm-service', () => ({ getLLMService: () => ({ isAvailable: async () => false }) }));

afterEach(() => {
  CompactionCoordinator._resetForTesting();
  setCompactionMarkerRecorderForTesting(null);
});

function harness(compactContext = vi.fn(async () => true), preTokens: unknown = 47076, postTokens: unknown = 10236) {
  CompactionCoordinator._resetForTesting();
  const record = vi.fn(() => 'synthetic-marker');
  setCompactionMarkerRecorderForTesting(record);
  const instance = {
    id: 'synthetic-instance', sessionId: 'synthetic-session', status: 'idle', workingDirectory: '/synthetic',
    contextUsage: { used: 40000, total: 200000, percentage: 20, occupancyReported: true },
    outputBuffer: [{ id: 'synthetic-message', timestamp: 1, type: 'user', content: 'Keep the task.' }],
  };
  const adapter = { compactContext, nativeCompactionKnownUnsupported: () => true,
    getTurnCompaction: () => ({ count: 1, preTokens, postTokens }) };
  const manager = {
    getAdapter: () => adapter, getInstance: () => instance,
    getAdapterRuntimeCapabilities: () => ({ supportsNativeCompaction: true }),
    updateInstanceStatus: vi.fn(), emitOutputMessage: vi.fn(),
    restartFreshInstance: vi.fn(async () => undefined), sendInput: vi.fn(async () => undefined),
  };
  setupCompactionCoordinator(manager as unknown as InstanceManager, { sendToRenderer: vi.fn() } as unknown as WindowManager);
  const coordinator = CompactionCoordinator.getInstance();
  coordinator.onContextUpdate(instance.id, instance.contextUsage);
  return { instance, manager, coordinator, record };
}

describe('Claude native compaction boundary through the runtime', () => {
  it.each(['residentTurnActive', 'awaitingOneShotCompletion', 'pendingInterruptResolve', 'pendingResidentInputs'] as const)(
    'refuses a live Claude turn at the coordinator before native or restart dispatch (%s)', async field => {
      const { coordinator, instance, manager } = harness();
      const adapter = new ClaudeCliAdapter({ residentClaude: true });
      const state = adapter as unknown as {
        process: unknown; residentTurnActive: boolean; awaitingOneShotCompletion: boolean;
        pendingInterruptResolve: (() => void) | null;
        pendingResidentInputs: number;
      };
      state.process = { stdin: { writable: true, destroyed: false } };
      if (field === 'pendingInterruptResolve') state.pendingInterruptResolve = () => undefined;
      else if (field === 'pendingResidentInputs') state.pendingResidentInputs = 1;
      else state[field] = true;
      const native = vi.spyOn(adapter, 'compactContext');
      vi.spyOn(manager as unknown as InstanceManager, 'getAdapter').mockReturnValue(adapter);
      const result = await coordinator.compactInstance(instance.id);
      expect(result).toMatchObject({ success: false, busy: true });
      expect(native).not.toHaveBeenCalled();
      expect(manager.restartFreshInstance).not.toHaveBeenCalled();
      expect(manager.sendInput).not.toHaveBeenCalled();
    },
  );

  it('records provider pre/post tokens on exactly one native boundary without restarting the session', async () => {
    const { coordinator, instance, manager, record } = harness();
    const result = await coordinator.compactInstance(instance.id);
    expect(result.success).toBe(true);
    expect(result.method).toBe('native');
    expect(result.previousUsage).toMatchObject({ used: 47076, total: 200000 });
    expect(result.previousUsage?.percentage).toBeCloseTo(23.538);
    expect(result.newUsage).toMatchObject({ used: 10236, total: 200000, isEstimated: false });
    expect(result.newUsage?.percentage).toBeCloseTo(5.118);
    expect(instance.contextUsage.used).toBe(10236);
    expect(record).toHaveBeenCalledOnce();
    expect(manager.emitOutputMessage).toHaveBeenCalledOnce();
    expect(manager.emitOutputMessage).toHaveBeenCalledWith(instance.id, expect.objectContaining({ metadata: expect.objectContaining({
      method: 'native', previousUsage: expect.objectContaining({ used: 47076 }), newUsage: expect.objectContaining({ used: 10236 }),
    }) }));
    expect(manager.restartFreshInstance).not.toHaveBeenCalled();
    expect(manager.sendInput).not.toHaveBeenCalled();
    expect(instance.sessionId).toBe('synthetic-session');
  });

  it.each([NaN, Infinity, -1, null])('does not put invalid provider measurements into the boundary (%s)', async invalid => {
    const { coordinator, instance } = harness(undefined, invalid, invalid);
    const result = await coordinator.compactInstance(instance.id);
    expect(result.previousUsage?.used).toBe(40000);
    expect(result.newUsage?.isEstimated).toBe(true);
    expect(result.newUsage?.used).toBe(40000);
  });

  it('falls back to restart and persists unsupported proof after the native attempt fails', async () => {
    const compactContext = vi.fn(async () => false);
    const { coordinator, instance, manager } = harness(compactContext);
    const result = await coordinator.compactInstance(instance.id);
    expect(result.success).toBe(true);
    expect(result.method).toBe('restart-with-summary');
    expect(result.nativeAttemptFailed).toBe(true);
    expect(coordinator.isNativeCompactionProvenUnsupported(instance.id)).toBe(true);
    expect(manager.restartFreshInstance).toHaveBeenCalledOnce();
    expect(manager.sendInput).toHaveBeenCalledOnce();
    expect(result.previousUsage?.used).toBe(40000);
  });
});
