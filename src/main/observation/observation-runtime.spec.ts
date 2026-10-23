import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';

const state = vi.hoisted(() => ({
  enabled: false,
  change: undefined as (() => void) | undefined,
  quit: undefined as (() => void) | undefined,
  configure: vi.fn(), initialize: vi.fn(), applyDecay: vi.fn(), workerEnabled: vi.fn(),
}));
vi.mock('electron', () => ({ app: {
  once: (_: string, fn: () => void) => { state.quit = fn; }, removeListener: vi.fn(),
} }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({
  get: () => state.enabled,
  on: (_: string, fn: () => void) => { state.change = fn; }, removeListener: vi.fn(),
}) }));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => ({ getActiveLoops: () => [] }) }));
vi.mock('../instance/context-worker-client', () => ({ getContextWorkerClient: () => ({ setObservationMemoryEnabled: state.workerEnabled }) }));
vi.mock('./observation-ingestor', () => ({ getObservationIngestor: () => ({ configure: state.configure, initialize: state.initialize }) }));
vi.mock('./observer-agent', () => ({ getObserverAgent: () => ({ configure: state.configure }) }));
vi.mock('./reflector-agent', () => ({ getReflectorAgent: () => ({ configure: state.configure }) }));
vi.mock('./policy-adapter', () => ({ getPolicyAdapter: () => ({ configure: state.configure }) }));
vi.mock('./observation-store', () => ({ getObservationStore: () => ({ configure: state.configure, applyDecay: state.applyDecay }) }));
import { initializeObservationRuntime } from './observation-runtime';

describe('Observation retention runtime', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); state.enabled = false; });
  afterEach(() => { state.quit?.(); vi.useRealTimers(); });
  it('cleans up at startup and daily while observation memory is OFF', () => {
    initializeObservationRuntime({} as InstanceManager);
    expect(state.applyDecay).toHaveBeenCalledTimes(1);
    expect(state.configure).toHaveBeenCalledWith({ enabled: false });
    expect(state.workerEnabled).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(state.applyDecay).toHaveBeenCalledTimes(2);
    state.quit?.();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(state.applyDecay).toHaveBeenCalledTimes(2);
  });
  it('live-applies an explicit opt-in to capture and worker prompt retrieval', () => {
    initializeObservationRuntime({} as InstanceManager);
    state.enabled = true;
    state.change?.();
    expect(state.configure).toHaveBeenLastCalledWith({ enabled: true });
    expect(state.workerEnabled).toHaveBeenLastCalledWith(true);
  });
});
