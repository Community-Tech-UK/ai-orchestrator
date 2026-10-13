import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetContextEvidenceRuntimeForTesting,
  getContextEvidenceRuntime,
  initializeContextEvidenceRuntime,
  startContextEvidenceMaintenance,
  stopContextEvidenceMaintenance,
  type ContextEvidenceRuntime,
} from './evidence-maintenance-runtime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(reconcile: (signal?: AbortSignal) => Promise<unknown>) {
  const maintenanceService = { reconcileStartup: vi.fn(reconcile) };
  const deletionService = {
    runJanitor: vi.fn(async () => undefined),
    startJanitorScheduler: vi.fn(), stopJanitorScheduler: vi.fn(), stop: vi.fn(async () => undefined),
  };
  const runtime = { maintenanceService, deletionService } as unknown as ContextEvidenceRuntime;
  return { runtime, maintenanceService, deletionService };
}

describe('context evidence runtime lifecycle', () => {
  afterEach(() => {
    _resetContextEvidenceRuntimeForTesting();
    vi.useRealTimers();
  });

  it('publishes readiness without awaiting bulk maintenance and starts just one generation', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const h = fixture(async () => gate.promise);
    const create = vi.fn(async () => h.runtime);
    await initializeContextEvidenceRuntime(create);
    expect(getContextEvidenceRuntime()).toBe(h.runtime);
    expect(h.maintenanceService.reconcileStartup).not.toHaveBeenCalled();
    await initializeContextEvidenceRuntime(create);
    startContextEvidenceMaintenance();
    startContextEvidenceMaintenance();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.maintenanceService.reconcileStartup).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(getContextEvidenceRuntime()).toBe(h.runtime);
    const stopped = stopContextEvidenceMaintenance();
    gate.resolve();
    await stopped;
    expect(h.deletionService.runJanitor).not.toHaveBeenCalled();
    expect(h.deletionService.startJanitorScheduler).not.toHaveBeenCalled();
  });

  it('never publishes an initialization that resolves after shutdown', async () => {
    const ready = deferred<ContextEvidenceRuntime>();
    const pending = initializeContextEvidenceRuntime(() => ready.promise);
    const rejected = expect(pending).rejects.toThrow('CONTEXT_EVIDENCE_RUNTIME_STOPPED');
    const stopped = stopContextEvidenceMaintenance();
    const h = fixture(async () => undefined);
    ready.resolve(h.runtime);
    await rejected;
    await stopped;
    expect(() => getContextEvidenceRuntime()).toThrow('CONTEXT_EVIDENCE_RUNTIME_UNAVAILABLE');
    expect(h.deletionService.stop).toHaveBeenCalledOnce();
  });

  it('does not let an old reset continuation replace the current runtime', async () => {
    const old = deferred<ContextEvidenceRuntime>();
    const pending = initializeContextEvidenceRuntime(() => old.promise);
    const rejected = expect(pending).rejects.toThrow('CONTEXT_EVIDENCE_RUNTIME_STOPPED');
    _resetContextEvidenceRuntimeForTesting();
    const current = fixture(async () => undefined);
    await initializeContextEvidenceRuntime(async () => current.runtime);
    old.resolve(fixture(async () => undefined).runtime);
    await rejected;
    expect(getContextEvidenceRuntime()).toBe(current.runtime);
  });

  it('keeps encryption failure unavailable and allows an explicit later retry', async () => {
    await expect(initializeContextEvidenceRuntime(async () => {
      throw new Error('SAFE_STORAGE_UNAVAILABLE');
    })).rejects.toThrow('SAFE_STORAGE_UNAVAILABLE');
    expect(() => getContextEvidenceRuntime()).toThrow('CONTEXT_EVIDENCE_RUNTIME_UNAVAILABLE');
    const h = fixture(async () => undefined);
    await initializeContextEvidenceRuntime(async () => h.runtime);
    expect(getContextEvidenceRuntime()).toBe(h.runtime);
  });
});
