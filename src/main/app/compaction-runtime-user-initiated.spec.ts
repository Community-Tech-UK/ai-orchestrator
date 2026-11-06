import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import { CompactionCoordinator } from '../context/compaction-coordinator';
import { _resetContextEngineForTesting } from '../context/context-engine';
import { applyCompaction, setCompactionMarkerRecorderForTesting, setupCompactionCoordinator } from './compaction-runtime';

// Step 7 item 5: "Explicit user actions (the 'Compact now' button ...) are not helper
// calls and are not capped." These tests pin the typed flag from each user entry
// point down to the restart-with-summary and native-compaction strategies, and
// pin that the automatic callers never carry it.

const prepared = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../context/restart-compaction', () => ({ prepareRestartCompaction: prepared.prepare }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => 0, on: vi.fn() }) }));
vi.mock('../conversation-ledger', () => ({ getConversationLedgerService: () => ({ listEvidence: async () => [] }) }));
vi.mock('../session/checkpoint-manager', () => ({
  getCheckpointManager: () => ({ createCheckpoint: async () => ({ id: 'ckpt-1' }) }),
}));

function restartManager(): InstanceManager {
  const instance = { id: 'inst-1', outputBuffer: [] };
  return {
    getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: false })),
    getAdapter: vi.fn(() => ({})),
    getInstance: vi.fn(() => instance),
    restartFreshInstance: vi.fn(async () => undefined),
    sendInput: vi.fn(async () => undefined),
    emitOutputMessage: vi.fn(),
  } as unknown as InstanceManager;
}

function nativeManager(compactContext: ReturnType<typeof vi.fn>): InstanceManager {
  const instance = { id: 'inst-1', outputBuffer: [] };
  return {
    getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: true })),
    getAdapter: vi.fn(() => ({ compactContext })),
    getInstance: vi.fn(() => instance),
    sendInput: vi.fn(),
    emitOutputMessage: vi.fn(),
  } as unknown as InstanceManager;
}

const windowManager = { sendToRenderer: vi.fn() } as unknown as WindowManager;

function userInitiatedOf(): unknown {
  return (prepared.prepare.mock.calls.at(-1) as [unknown, { userInitiated?: boolean }] | undefined)?.[1]?.userInitiated;
}

describe('user-initiated compaction reaches the summary helper unmetered (Step 7 item 5)', () => {
  beforeEach(() => {
    CompactionCoordinator._resetForTesting();
    _resetContextEngineForTesting();
    setCompactionMarkerRecorderForTesting(() => undefined);
    prepared.prepare.mockReset();
    prepared.prepare.mockResolvedValue({ text: 'handoff', stats: { summaryGenerated: true } });
  });

  afterEach(() => {
    setCompactionMarkerRecorderForTesting(null);
    CompactionCoordinator._resetForTesting();
    _resetContextEngineForTesting();
  });

  it('the plain Compact now button asks for a user-initiated summary', async () => {
    const manager = restartManager();
    setupCompactionCoordinator(manager, windowManager);

    const result = await applyCompaction(manager, 'inst-1');

    expect(result.success).toBe(true);
    expect(prepared.prepare).toHaveBeenCalledOnce();
    expect(userInitiatedOf()).toBe(true);
  });

  it('confirming the boundary dialog is also user-initiated and keeps its boundary', async () => {
    const manager = restartManager();
    setupCompactionCoordinator(manager, windowManager);

    await applyCompaction(manager, 'inst-1', { keepLatestExchanges: 2 });

    expect(userInitiatedOf()).toBe(true);
    expect(prepared.prepare).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ keepLatestExchanges: 2, userInitiated: true }),
    );
  });

  it('a typed /compact reaches the helper as user-initiated when its caller says it is manual', async () => {
    const manager = restartManager();
    setupCompactionCoordinator(manager, windowManager);

    await CompactionCoordinator.getInstance().compactInstance('inst-1', { trigger: 'manual' });

    expect(userInitiatedOf()).toBe(true);
  });

  it('a compaction nobody asked for stays capped: no options (policy rebuild, auto trigger) carries no flag', async () => {
    const manager = restartManager();
    setupCompactionCoordinator(manager, windowManager);

    await CompactionCoordinator.getInstance().compactInstance('inst-1');

    expect(prepared.prepare).toHaveBeenCalledOnce();
    expect(userInitiatedOf()).toBe(false);
  });

  it('an overflow recovery stays capped', async () => {
    const manager = restartManager();
    setupCompactionCoordinator(manager, windowManager);

    await CompactionCoordinator.getInstance().compactInstance('inst-1', { trigger: 'overflow' });

    expect(userInitiatedOf()).toBe(false);
  });

  it('Compact now on a native-compaction session tells the adapter it is user-initiated', async () => {
    const compactContext = vi.fn(async () => true);
    const manager = nativeManager(compactContext);
    setupCompactionCoordinator(manager, windowManager);

    await applyCompaction(manager, 'inst-1');

    expect(compactContext).toHaveBeenCalledTimes(1);
    expect(compactContext).toHaveBeenCalledWith({ userInitiated: true });
  });

  it('an automatic native compaction calls the adapter with no flag', async () => {
    const compactContext = vi.fn(async () => true);
    const manager = nativeManager(compactContext);
    setupCompactionCoordinator(manager, windowManager);

    await CompactionCoordinator.getInstance().compactInstance('inst-1');

    expect(compactContext).toHaveBeenCalledTimes(1);
    expect(compactContext).toHaveBeenCalledWith();
  });
});
