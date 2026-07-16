import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactionCoordinator } from '../context/compaction-coordinator';
import type { EvidenceLedgerRecord } from '../conversation-ledger/context-evidence-ledger.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import {
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
    const sendInput = vi.fn(async () => undefined);
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
