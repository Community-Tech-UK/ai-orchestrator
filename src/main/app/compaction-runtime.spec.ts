import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactionCoordinator } from '../context/compaction-coordinator';
import { _resetContextEngineForTesting } from '../context/context-engine';
import { ContextCompactor } from '../context/context-compactor';
import { CheckpointType } from '../../shared/types/error-recovery.types';
import type { EvidenceLedgerRecord } from '../conversation-ledger/context-evidence-ledger.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import {
  applyCompaction,
  recordProviderThreadCompactionMarker,
  setCompactionMarkerRecorderForTesting,
  setupCompactionCoordinator,
} from './compaction-runtime';

const settingsManagerMock = vi.hoisted(() => ({
  get: vi.fn(() => 0),
  on: vi.fn(),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => settingsManagerMock,
}));

const checkpointManagerMock = vi.hoisted(() => ({
  createCheckpoint: vi.fn(),
}));

vi.mock('../session/checkpoint-manager', () => ({
  getCheckpointManager: () => checkpointManagerMock,
}));

const evidenceMocks = vi.hoisted(() => ({
  listEvidence: vi.fn(),
  read: vi.fn(),
  deriveCitationDigest: vi.fn(),
}));

vi.mock('../conversation-ledger', () => ({
  getConversationLedgerService: () => ({ listEvidence: evidenceMocks.listEvidence }),
}));

vi.mock('../context-evidence/evidence-maintenance-service', () => ({
  getContextEvidenceRuntime: () => ({
    blobStore: {
      read: evidenceMocks.read,
      deriveCitationDigest: evidenceMocks.deriveCitationDigest,
    },
  }),
}));

function makeWindowManager(): WindowManager {
  return {
    sendToRenderer: vi.fn(),
  } as unknown as WindowManager;
}

describe('setupCompactionCoordinator', () => {
  beforeEach(() => {
    CompactionCoordinator._resetForTesting();
    setCompactionMarkerRecorderForTesting(() => undefined);
    settingsManagerMock.get.mockReset();
    settingsManagerMock.get.mockReturnValue(0);
    settingsManagerMock.on.mockReset();
    evidenceMocks.listEvidence.mockReset();
    evidenceMocks.listEvidence.mockResolvedValue([]);
    evidenceMocks.read.mockReset();
    evidenceMocks.deriveCitationDigest.mockReset();
    evidenceMocks.deriveCitationDigest.mockResolvedValue('d'.repeat(64));
  });

  afterEach(() => {
    setCompactionMarkerRecorderForTesting(null);
    CompactionCoordinator._resetForTesting();
    vi.restoreAllMocks();
  });

  it('uses adapter compactContext directly when the adapter exposes a programmatic hook', async () => {
    const compactContext = vi.fn(async () => true);
    const sendInput = vi.fn(async () => undefined);
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: true })),
      getAdapter: vi.fn(() => ({ compactContext })),
      getInstance: vi.fn(() => undefined),
      sendInput,
      emitOutputMessage: vi.fn(),
    } as unknown as InstanceManager;

    setupCompactionCoordinator(instanceManager, makeWindowManager());

    const result = await CompactionCoordinator.getInstance().compactInstance('inst-1');

    expect(result.success).toBe(true);
    expect(result.method).toBe('native');
    expect(compactContext).toHaveBeenCalledOnce();
    expect(sendInput).not.toHaveBeenCalled();
  });

  // LT-045: the per-adapter LT-017 sticky flag is wiped by every restart-with-
  // summary respawn, so a manual-compaction caller paid the full 30s
  // confirmation timeout on every single compaction, not just the first, for
  // any provider build that never confirms native compaction. The
  // coordinator-level record must survive across a respawn (simulated here
  // by `getAdapter` returning a *different* adapter object the second time,
  // exactly as happens after restart-with-summary replaces the adapter).
  it('skips the native RPC on a later compaction once the coordinator has proven it unsupported, even for a new adapter object (respawn)', async () => {
    const firstAdapter = {
      compactContext: vi.fn(async () => false),
      nativeCompactionKnownUnsupported: vi.fn(() => true),
    };
    const secondAdapter = {
      compactContext: vi.fn(async () => false),
      nativeCompactionKnownUnsupported: vi.fn(() => true),
    };
    const restartCompact = vi.fn(async () => undefined);
    const adapters = [firstAdapter, secondAdapter];
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: true })),
      getAdapter: vi.fn(() => adapters.shift() ?? secondAdapter),
      getInstance: vi.fn(() => ({ id: 'inst-lt045', outputBuffer: [] })),
      sendInput: vi.fn(),
      restartInstance: restartCompact,
      restartFreshInstance: restartCompact,
      emitOutputMessage: vi.fn(),
    } as unknown as InstanceManager;

    setupCompactionCoordinator(instanceManager, makeWindowManager());
    const coordinator = CompactionCoordinator.getInstance();

    const first = await coordinator.compactInstance('inst-lt045');
    expect(first.method).toBe('restart-with-summary');
    expect(first.nativeAttemptFailed).toBe(true);
    expect(firstAdapter.compactContext).toHaveBeenCalledOnce();
    expect(coordinator.isNativeCompactionProvenUnsupported('inst-lt045')).toBe(true);

    // Simulated respawn: a brand-new adapter object now backs the instance,
    // exactly like restart-with-summary replacing the adapter.
    const second = await coordinator.compactInstance('inst-lt045');
    expect(second.method).toBe('restart-with-summary');
    expect(second.nativeAttemptFailed).toBe(true);
    // The proof: the SECOND adapter's compactContext was never called at all.
    expect(secondAdapter.compactContext).not.toHaveBeenCalled();
  });

  it('clears the proven-unsupported record on instance cleanup', () => {
    const coordinator = CompactionCoordinator.getInstance();
    coordinator.recordNativeCompactionProvenUnsupported('inst-cleanup');
    expect(coordinator.isNativeCompactionProvenUnsupported('inst-cleanup')).toBe(true);

    coordinator.cleanupInstance('inst-cleanup');

    expect(coordinator.isNativeCompactionProvenUnsupported('inst-cleanup')).toBe(false);
  });

  it('resets renderer context usage after successful native compaction when no provider context event follows', async () => {
    const compactContext = vi.fn(async () => true);
    const recordMarker = vi.fn(() => 'marker-1');
    setCompactionMarkerRecorderForTesting(recordMarker);
    const instance = {
      id: 'inst-1',
      providerSessionId: 'thread-1',
      sessionId: 'legacy-thread-1',
      workingDirectory: '/repo',
      status: 'busy',
      contextUsage: {
        used: 188_000,
        total: 200_000,
        percentage: 94,
        cumulativeTokens: 500_000,
        source: 'provider-usage',
        occupancyReported: true,
      },
      outputBuffer: [],
    };
    const updateInstanceStatus = vi.fn();
    const emitOutputMessage = vi.fn();

    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: true })),
      getAdapter: vi.fn(() => ({ compactContext })),
      getInstance: vi.fn(() => instance),
      sendInput: vi.fn(),
      emitOutputMessage,
      updateInstanceStatus,
    } as unknown as InstanceManager;

    setupCompactionCoordinator(instanceManager, makeWindowManager());
    const coordinator = CompactionCoordinator.getInstance();

    coordinator.setAutoCompact(false);
    coordinator.onContextUpdate('inst-1', instance.contextUsage);
    const result = await coordinator.compactInstance('inst-1');

    expect(result.success).toBe(true);
    expect(instance.contextUsage).toMatchObject({
      used: 0,
      total: 200_000,
      percentage: 0,
      source: 'post-compaction-reset',
      isEstimated: true,
      // LT-018: a post-compaction `used: 0` is a real measurement, so occupancy
      // stays reported. Dropping it here would blank the context ring to
      // "no data" after every compaction on providers that do report occupancy.
      occupancyReported: true,
    });
    expect(updateInstanceStatus).toHaveBeenCalledWith('inst-1', 'busy', {
      reason: 'context-compacted',
      method: 'native',
    });
    expect(recordMarker).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'inst-1',
      threadId: 'thread-1',
      projectKey: '/repo',
      method: 'native',
      utilizationBefore: 94,
      utilizationAfter: 0,
    }));
    expect(emitOutputMessage).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        metadata: expect.objectContaining({
          previousUsage: expect.objectContaining({ percentage: 94 }),
          newUsage: expect.objectContaining({ percentage: 0 }),
          compactionMarkerId: 'marker-1',
        }),
      }),
    );
  });

  it('preserves occupancyIsAggregate across compaction (LT-034)', async () => {
    // buildPostCompactionUsage rebuilds the usage object field by field — the
    // exact shape that silently dropped `occupancyReported` and would have
    // regressed LT-018. Compaction does not change what a provider is capable
    // of reporting, so an aggregate-only session is still aggregate-only
    // afterwards; losing the flag here would re-fabricate a context-window
    // percentage out of cumulative spend on the next render.
    const compactContext = vi.fn(async () => true);
    setCompactionMarkerRecorderForTesting(vi.fn(() => 'marker-agg'));
    const instance = {
      id: 'inst-agg',
      providerSessionId: 'thread-agg',
      sessionId: 'legacy-thread-agg',
      workingDirectory: '/repo',
      status: 'busy',
      contextUsage: {
        used: 103_222,
        total: 200_000,
        percentage: 51.6,
        cumulativeTokens: 103_222,
        source: 'provider-usage',
        occupancyReported: true,
        occupancyIsAggregate: true,
      },
      outputBuffer: [],
    };
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: true })),
      getAdapter: vi.fn(() => ({ compactContext })),
      getInstance: vi.fn(() => instance),
      sendInput: vi.fn(),
      emitOutputMessage: vi.fn(),
      updateInstanceStatus: vi.fn(),
    } as unknown as InstanceManager;

    setupCompactionCoordinator(instanceManager, makeWindowManager());
    const coordinator = CompactionCoordinator.getInstance();
    coordinator.setAutoCompact(false);
    coordinator.onContextUpdate('inst-agg', instance.contextUsage);
    const result = await coordinator.compactInstance('inst-agg');

    expect(result.success).toBe(true);
    expect(instance.contextUsage).toMatchObject({
      used: 0,
      occupancyReported: true,
      occupancyIsAggregate: true,
    });
  });

  it('does NOT fall back to sending /compact as user text when no compactContext exists', async () => {
    // Regression: the runtime used to call `adapter.sendInput("/compact")` in
    // this case. For Claude CLI in `--input-format stream-json` mode that text
    // was delivered to the model as a normal user message and the model
    // replied with an explanation of `/compact` instead of compacting.
    // The native strategy must now report failure (false) so the coordinator
    // falls through to the restart-with-summary strategy that actually
    // performs compaction.
    const adapterSendInput = vi.fn(async () => undefined);
    const managerSendInput = vi.fn(async () => undefined);
    const restartInstance = vi.fn(async () => undefined);
    const restartFreshInstance = vi.fn(async () => undefined);
    const emitOutputMessage = vi.fn();
    const instance = {
      id: 'inst-1',
      outputBuffer: [
        { id: 'm1', type: 'user' as const, content: 'Build a feature.', timestamp: 1 },
        { id: 'm2', type: 'assistant' as const, content: 'Plan: do X.', timestamp: 2 },
      ],
    };

    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: true })),
      getAdapter: vi.fn(() => ({ sendInput: adapterSendInput })),
      getInstance: vi.fn(() => instance),
      sendInput: managerSendInput,
      restartInstance,
      restartFreshInstance,
      emitOutputMessage,
    } as unknown as InstanceManager;

    setupCompactionCoordinator(instanceManager, makeWindowManager());

    const result = await CompactionCoordinator.getInstance().compactInstance('inst-1');

    // No fake `/compact` user message must reach the adapter under any
    // circumstance.
    expect(adapterSendInput).not.toHaveBeenCalled();

    // Manual compaction must still produce a real result. The native strategy
    // returned false (no programmatic hook), so the coordinator falls through
    // to restart-with-summary which actually compacts.
    expect(result.success).toBe(true);
    expect(result.method).toBe('restart-with-summary');
    // Compaction must use the FRESH restart (clean session) — not the
    // context-preserving `restartInstance`, which would resume/replay the old
    // conversation and defeat compaction (context snaps back to ~100%).
    expect(restartFreshInstance).toHaveBeenCalledWith('inst-1');
    expect(restartInstance).not.toHaveBeenCalled();
    // The continuity prompt is sent through the manager-level sendInput as
    // part of restart-with-summary.
    expect(managerSendInput).toHaveBeenCalledWith(
      'inst-1',
      expect.stringContaining('[Context Compaction Continuity Package]'),
      undefined,
      { automatedInput: true },
    );
    // Real compaction → boundary marker should be emitted.
    expect(emitOutputMessage).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        type: 'system',
        content: '— Context compacted —',
      }),
    );
  });

  it('includes only blob-authenticated evidence in restart continuity packages', async () => {
    const content = new TextEncoder().encode('authenticated evidence body');
    evidenceMocks.listEvidence.mockResolvedValue([makeEvidenceRecord(content.byteLength)]);
    evidenceMocks.read.mockResolvedValue(Uint8Array.from(content));
    const sendInput = vi.fn(async (_instanceId: string, _message: string) => undefined);
    const instance = {
      id: 'inst-evidence',
      contextEvidence: {
        mode: 'enforce',
        conversationId: 'conversation-evidence',
        captureFailureCount: 0,
      },
      outputBuffer: [
        { id: 'm1', type: 'user' as const, content: 'Continue the evidence task.', timestamp: 1 },
        { id: 'm2', type: 'assistant' as const, content: 'Working on it.', timestamp: 2 },
      ],
    };
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: false })),
      getAdapter: vi.fn(() => ({})),
      getInstance: vi.fn(() => instance),
      restartFreshInstance: vi.fn(async () => undefined),
      sendInput,
      emitOutputMessage: vi.fn(),
    } as unknown as InstanceManager;

    setupCompactionCoordinator(instanceManager, makeWindowManager());
    const authenticated = await CompactionCoordinator.getInstance().compactInstance('inst-evidence');

    expect(authenticated.success).toBe(true);
    const authenticatedPrompt = sendInput.mock.calls[0]![1];
    expect(authenticatedPrompt).toContain('[evidence:evidence-runtime@0-27#');
    expect(authenticatedPrompt).toContain('authenticated evidence body');

    CompactionCoordinator._resetForTesting();
    sendInput.mockClear();
    evidenceMocks.read.mockRejectedValueOnce(new Error('authentication failed'));
    setupCompactionCoordinator(instanceManager, makeWindowManager());
    const rejected = await CompactionCoordinator.getInstance().compactInstance('inst-evidence');

    expect(rejected.success).toBe(true);
    const rejectedPrompt = sendInput.mock.calls[0]![1];
    expect(rejectedPrompt).not.toContain('[evidence:evidence-runtime@');
    expect(rejectedPrompt).not.toContain('authenticated evidence body');
    expect(rejectedPrompt).toContain('No authenticated evidence previews were available');
  });

  it('wires selfManagesAutoCompaction so the coordinator skips background auto-trigger for Claude-style adapters', () => {
    // Build a fake instanceManager that mirrors the Claude-style capability
    // surface: no callable native hook, but `selfManagedAutoCompaction: true`.
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({
        supportsNativeCompaction: false,
        selfManagedAutoCompaction: true,
      })),
      getAdapter: vi.fn(() => ({})),
      getInstance: vi.fn(() => undefined),
      sendInput: vi.fn(),
      restartInstance: vi.fn(),
      emitOutputMessage: vi.fn(),
    } as unknown as InstanceManager;

    setupCompactionCoordinator(instanceManager, makeWindowManager());

    const coordinator = CompactionCoordinator.getInstance();
    expect(coordinator.isSelfManagedAutoCompaction('inst-1')).toBe(true);
  });

  it('records provider-managed thread compactions as self-managed markers', () => {
    const recordMarker = vi.fn(() => 'marker-1');
    setCompactionMarkerRecorderForTesting(recordMarker);

    expect(recordProviderThreadCompactionMarker({
      instanceId: 'inst-1',
      instance: {
        id: 'inst-1',
        provider: 'codex',
        providerSessionId: 'thread-provider',
        sessionId: 'thread-local',
        workingDirectory: '/repo',
        contextUsage: {
          used: 25_000,
          total: 100_000,
          percentage: 25,
        },
      } as never,
      provider: 'codex',
      sessionId: 'thread-envelope',
      messageId: 'msg-1',
      createdAt: 1234,
      messageMetadata: { threadCompacted: true },
    })).toBe('marker-1');

    expect(recordMarker).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'inst-1',
      threadId: 'thread-envelope',
      projectKey: '/repo',
      method: 'self-managed',
      createdAt: 1234,
      utilizationBefore: null,
      utilizationAfter: 25,
      ledgerAnchor: 1234,
      metadata: expect.objectContaining({
        source: 'provider-thread-compacted',
        provider: 'codex',
        messageId: 'msg-1',
        messageMetadata: { threadCompacted: true },
      }),
    }));
  });
});

describe('applyCompaction (WS-B7)', () => {
  beforeEach(() => {
    CompactionCoordinator._resetForTesting();
    ContextCompactor._resetForTesting();
    // `getContextEngine()` is a separate module-level singleton from
    // `CompactionCoordinator` — without resetting it too, a `LegacyContextEngine`
    // constructed in an earlier test keeps a stale reference to a coordinator
    // instance that later tests already reset out from under it.
    _resetContextEngineForTesting();
    setCompactionMarkerRecorderForTesting(() => undefined);
    settingsManagerMock.get.mockReset();
    settingsManagerMock.get.mockReturnValue(0);
    settingsManagerMock.on.mockReset();
    evidenceMocks.listEvidence.mockReset();
    evidenceMocks.listEvidence.mockResolvedValue([]);
    checkpointManagerMock.createCheckpoint.mockReset();
    checkpointManagerMock.createCheckpoint.mockResolvedValue({ id: 'ckpt-1' });
  });

  afterEach(() => {
    setCompactionMarkerRecorderForTesting(null);
    CompactionCoordinator._resetForTesting();
    ContextCompactor._resetForTesting();
    _resetContextEngineForTesting();
    vi.restoreAllMocks();
  });

  function makeNativeInstanceManager() {
    const compactContext = vi.fn(async () => true);
    const emitOutputMessage = vi.fn();
    const instance = { id: 'inst-1', outputBuffer: [] };
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: true })),
      getAdapter: vi.fn(() => ({ compactContext })),
      getInstance: vi.fn(() => instance),
      sendInput: vi.fn(),
      emitOutputMessage,
    } as unknown as InstanceManager;
    return { instanceManager, emitOutputMessage };
  }

  it('creates a labeled pre-compaction checkpoint and attaches its id to the compaction boundary message', async () => {
    const { instanceManager, emitOutputMessage } = makeNativeInstanceManager();
    setupCompactionCoordinator(instanceManager, makeWindowManager());

    const result = await applyCompaction(instanceManager, 'inst-1', { keepLatestExchanges: 2 });

    expect(result.success).toBe(true);
    expect(checkpointManagerMock.createCheckpoint).toHaveBeenCalledWith(
      'inst-1',
      CheckpointType.MANUAL,
      expect.stringContaining('keep latest 2 exchanges'),
    );
    expect(emitOutputMessage).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        metadata: expect.objectContaining({ checkpointId: 'ckpt-1' }),
      }),
    );
  });

  it('uses a plain label and singular "exchange" wording for a single-exchange boundary', async () => {
    const { instanceManager } = makeNativeInstanceManager();
    setupCompactionCoordinator(instanceManager, makeWindowManager());

    await applyCompaction(instanceManager, 'inst-1', { keepLatestExchanges: 1 });

    expect(checkpointManagerMock.createCheckpoint).toHaveBeenCalledWith(
      'inst-1',
      CheckpointType.MANUAL,
      'Before manual compaction (keep latest 1 exchange)',
    );
  });

  it('uses the plain "Before manual compaction" label with no boundary (plain Compact Now path)', async () => {
    const { instanceManager } = makeNativeInstanceManager();
    setupCompactionCoordinator(instanceManager, makeWindowManager());

    await applyCompaction(instanceManager, 'inst-1');

    expect(checkpointManagerMock.createCheckpoint).toHaveBeenCalledWith(
      'inst-1',
      CheckpointType.MANUAL,
      'Before manual compaction',
    );
  });

  it('swallows a checkpoint-creation failure and still compacts (no checkpointId attached)', async () => {
    checkpointManagerMock.createCheckpoint.mockRejectedValueOnce(new Error('disk full'));
    const { instanceManager, emitOutputMessage } = makeNativeInstanceManager();
    setupCompactionCoordinator(instanceManager, makeWindowManager());

    const result = await applyCompaction(instanceManager, 'inst-1');

    expect(result.success).toBe(true);
    const boundaryCall = emitOutputMessage.mock.calls.find(
      (call) => (call[1] as { content?: string }).content === '— Context compacted —',
    );
    expect(boundaryCall).toBeDefined();
    expect((boundaryCall![1] as { metadata: Record<string, unknown> }).metadata['checkpointId']).toBeUndefined();
  });

  it('honors an explicit keepLatestExchanges boundary on the restart-with-summary path', async () => {
    const instance = {
      id: 'inst-restart',
      outputBuffer: [
        { id: 'm1', type: 'user' as const, content: 'one', timestamp: 1 },
        { id: 'm2', type: 'assistant' as const, content: 'two', timestamp: 2 },
        { id: 'm3', type: 'user' as const, content: 'three', timestamp: 3 },
        { id: 'm4', type: 'assistant' as const, content: 'four', timestamp: 4 },
      ],
    };
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: false })),
      getAdapter: vi.fn(() => ({})),
      getInstance: vi.fn(() => instance),
      restartFreshInstance: vi.fn(async () => undefined),
      sendInput: vi.fn(async () => undefined),
      emitOutputMessage: vi.fn(),
    } as unknown as InstanceManager;
    setupCompactionCoordinator(instanceManager, makeWindowManager());

    const compactSpy = vi.spyOn(ContextCompactor.getInstance(), 'compact');

    const result = await applyCompaction(instanceManager, 'inst-restart', { keepLatestExchanges: 1 });

    expect(result.success).toBe(true);
    // 1 exchange = the trailing user+assistant pair = 2 messages.
    expect(compactSpy).toHaveBeenCalledWith({ preserveRecentOverride: 2 });
  });

  it('is byte-compatible with the pre-WS-B7 default when no boundary is given (no override passed to compact())', async () => {
    const instance = {
      id: 'inst-restart-default',
      outputBuffer: [
        { id: 'm1', type: 'user' as const, content: 'one', timestamp: 1 },
        { id: 'm2', type: 'assistant' as const, content: 'two', timestamp: 2 },
      ],
    };
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: false })),
      getAdapter: vi.fn(() => ({})),
      getInstance: vi.fn(() => instance),
      restartFreshInstance: vi.fn(async () => undefined),
      sendInput: vi.fn(async () => undefined),
      emitOutputMessage: vi.fn(),
    } as unknown as InstanceManager;
    setupCompactionCoordinator(instanceManager, makeWindowManager());

    const compactSpy = vi.spyOn(ContextCompactor.getInstance(), 'compact');

    await applyCompaction(instanceManager, 'inst-restart-default');

    expect(compactSpy).toHaveBeenCalledWith(undefined);
  });
});

function makeEvidenceRecord(byteCount: number): EvidenceLedgerRecord {
  return {
    id: 'evidence-runtime',
    conversationId: 'conversation-evidence',
    provider: 'codex',
    providerThreadRef: null,
    providerSessionRef: null,
    turnRef: null,
    toolCallRef: null,
    toolName: 'read_file',
    sourceKind: 'file',
    sourceLocatorRedacted: null,
    status: 'complete',
    blobRef: 'opaque/runtime.aioev1',
    keyedContentId: 'c'.repeat(64),
    byteCount,
    tokenEstimate: null,
    mimeType: 'text/plain',
    sensitivity: 'normal',
    provenanceTrust: 'runtime-authenticated',
    captureMode: 'post-retention',
    captureCompleteness: 'complete',
    truncationReason: null,
    keyVersion: 1,
    captureKey: 'capture-runtime',
    createdAt: 1,
    completedAt: 2,
    updatedAt: 2,
  };
}
