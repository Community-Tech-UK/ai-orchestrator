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
  CONTEXT_POLICY_STEER_NOTICE,
  recordProviderThreadCompactionMarker,
  setCompactionMarkerRecorderForTesting,
  setupCompactionCoordinator,
} from './compaction-runtime';
import { setDecisionLogRecorderForTesting } from '../context/compaction-decision-log';
import { CONTEXT_RECOVERY_LOOKUP_SENTENCE } from '../context/context-recovery-block';
import {
  initializeSessionTranscriptReader,
  SessionTranscriptReader,
} from '../session/session-transcript-reader';
import type { OutputMessage } from '../../shared/types/instance.types';
import { CONTINUITY_WAIT_RULE } from '../context/compaction-continuity';
import { getLLMService } from '../rlm/llm-service';

const settingsManagerMock = vi.hoisted(() => ({
  get: vi.fn(() => 0),
  on: vi.fn(),
}));

vi.mock('../rlm/llm-service', () => ({ getLLMService: () => ({ isAvailable: async () => false }) }));

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

// A11 part 1b: the context-recovery pointer asks the bridge lookups and the
// transcript merge; control both without touching the real RPC server module.
const bridgeLookups = vi.hoisted(() => ({
  binary: process.execPath as string | null,
  socket: '/tmp/orchestrator-tools.sock' as string | null,
}));

vi.mock('../util/aio-mcp-cli-path', () => ({
  resolveAioMcpCliPath: () => bridgeLookups.binary,
}));

vi.mock('../mcp/orchestrator-tools-rpc-server', () => ({
  getOrchestratorToolsRpcSocketPath: () => bridgeLookups.socket,
}));

const completeMessagesMock = vi.hoisted(() => ({
  impl: async (instance: { outputBuffer: unknown[] }) => instance.outputBuffer,
}));

vi.mock('../history/complete-instance-messages', () => ({
  getCompleteInstanceMessages: (instance: { outputBuffer: unknown[] }) =>
    completeMessagesMock.impl(instance),
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
  // by `getAdapter` returning a *different* adapter object once the first
  // restart-with-summary has run, exactly as happens in production).
  it('skips the native RPC on a later compaction once the coordinator has proven it unsupported, even for a new adapter object (respawn)', async () => {
    const firstAdapter = {
      compactContext: vi.fn(async () => false),
      nativeCompactionKnownUnsupported: vi.fn(() => true),
    };
    const secondAdapter = {
      compactContext: vi.fn(async () => false),
      nativeCompactionKnownUnsupported: vi.fn(() => true),
    };
    // The respawn happens where it does in production: restart-with-summary's
    // fresh restart replaces the adapter. Keying the swap to a getAdapter call
    // count instead broke as soon as compaction read the adapter twice.
    let currentAdapter = firstAdapter;
    const restartCompact = vi.fn(async () => { currentAdapter = secondAdapter; });
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: true })),
      getAdapter: vi.fn(() => currentAdapter),
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

  it('treats Codex turnPhase idle as the only safe 75% compact boundary', async () => {
    const compactContext = vi.fn(async () => true);
    const executeContextAction = vi.fn(async (action: string) => (
      action === 'steer-turn' ? { proof: 'acknowledged' as const } : { proof: 'none' as const }
    ));
    const adapter = {
      compactContext,
      executeContextAction,
      getContextCapabilities: () => ({
        toolResultControl: 'post-retention',
        toolResultVisibility: 'full',
        transcriptControl: 'native-compaction',
        occupancyReporting: 'current',
        cumulativeReporting: 'available',
        interruptProof: 'observed',
        compactionProof: 'observed',
        sameThreadContinuation: true,
      }),
      getRuntimeSnapshot: vi.fn(() => ({ turnPhase: 'running' })),
    };
    const instance = { id: 'inst-boundary', contextEvidence: { mode: 'enforce' } };
    const sendInput = vi.fn();
    const emitSystemMessage = vi.fn();
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({
        supportsNativeCompaction: true,
        selfManagedAutoCompaction: false,
      })),
      getAdapter: vi.fn(() => adapter),
      getInstance: vi.fn(() => instance),
      sendInput,
      emitSystemMessage,
      emitOutputMessage: vi.fn(),
    } as unknown as InstanceManager;

    setupCompactionCoordinator(instanceManager, makeWindowManager());
    const coordinator = CompactionCoordinator.getInstance();
    const pressure = { used: 75, total: 100, percentage: 75, cumulativeTokens: 75 };

    coordinator.onContextUpdate('inst-boundary', pressure);
    await coordinator.drainPolicyDecisions('inst-boundary');
    expect(executeContextAction).toHaveBeenCalledWith('steer-turn');
    expect(compactContext).not.toHaveBeenCalled();
    // LT-657: the steer reaches the agent through the adapter's policy channel
    // only; the transcript records it as a Harness notice, never as user input.
    expect(sendInput).not.toHaveBeenCalled();
    expect(emitSystemMessage).toHaveBeenCalledWith('inst-boundary', CONTEXT_POLICY_STEER_NOTICE, {
      internalInput: { actor: 'harness', source: 'context-policy' },
    });
    expect(CONTEXT_POLICY_STEER_NOTICE).toContain('not a message from you');

    adapter.getRuntimeSnapshot.mockReturnValue({ turnPhase: 'idle' });
    coordinator.onContextUpdate('inst-boundary', pressure);
    await coordinator.drainPolicyDecisions('inst-boundary');
    expect(compactContext).toHaveBeenCalledOnce();
  });

  // W6 item 4, through the real wiring: the busy test reads the adapter's live
  // runtime snapshot, so a running Codex turn blocks both strategies.
  it('refuses manual compaction during a live Codex turn instead of falling back to restart-with-summary', async () => {
    checkpointManagerMock.createCheckpoint.mockClear();
    const compactContext = vi.fn(async () => false);
    const restartFreshInstance = vi.fn(async () => undefined);
    const adapter = {
      compactContext,
      getRuntimeSnapshot: vi.fn((): { turnPhase: string; activeTurnId: string | null } => ({ turnPhase: 'running', activeTurnId: 'turn-1' })),
    };
    const emitOutputMessage = vi.fn();
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: true })),
      getAdapter: vi.fn(() => adapter),
      getInstance: vi.fn(() => ({ id: 'inst-busy', outputBuffer: [] })),
      sendInput: vi.fn(),
      restartFreshInstance,
      emitOutputMessage,
    } as unknown as InstanceManager;

    setupCompactionCoordinator(instanceManager, makeWindowManager());
    const busy = await applyCompaction(instanceManager, 'inst-busy');

    expect(busy).toMatchObject({ success: false, busy: true });
    expect(busy.error).toMatch(/once the current turn finishes/);
    expect(compactContext).not.toHaveBeenCalled();
    expect(restartFreshInstance).not.toHaveBeenCalled();
    // A refused click must not leave an unused "Before manual compaction" checkpoint.
    expect(checkpointManagerMock.createCheckpoint).not.toHaveBeenCalled();
    // ...and the user is told why nothing happened, whichever route asked for compaction.
    expect(emitOutputMessage).toHaveBeenCalledWith('inst-busy', expect.objectContaining({
      type: 'system',
      content: expect.stringMatching(/once the current turn finishes/),
      metadata: { compactionRefused: true },
    }));

    adapter.getRuntimeSnapshot.mockReturnValue({ turnPhase: 'idle', activeTurnId: null });
    compactContext.mockResolvedValue(true);
    await expect(applyCompaction(instanceManager, 'inst-busy')).resolves.toMatchObject({
      success: true,
      method: 'native',
    });
    expect(checkpointManagerMock.createCheckpoint).toHaveBeenCalledTimes(1);
  });

  // W6 item 3, through the real wiring: the adapter's "no live turn" steer
  // answer must reach the policy runtime as a skip, and the adapter's outer-send
  // id must scope the recovery ceiling.
  it('passes steer skips and the adapter outer-send id through to the shared policy', async () => {
    const executeContextAction = vi.fn(async (action: string) => (
      action === 'steer-turn'
        ? { proof: 'none' as const, skipped: 'turn-not-active' as const }
        : { proof: 'acknowledged' as const }
    ));
    let outerSendId = 'send-1';
    const adapter = {
      executeContextAction,
      getContextOuterSendId: () => outerSendId,
      getContextCapabilities: () => ({
        toolResultControl: 'post-retention',
        toolResultVisibility: 'full',
        transcriptControl: 'native-compaction',
        occupancyReporting: 'current',
        cumulativeReporting: 'available',
        interruptProof: 'observed',
        compactionProof: 'observed',
        sameThreadContinuation: true,
      }),
      getRuntimeSnapshot: vi.fn(() => ({ turnPhase: 'running' })),
    };
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: true })),
      getAdapter: vi.fn(() => adapter),
      getInstance: vi.fn(() => ({ id: 'inst-policy', contextEvidence: { mode: 'enforce' } })),
      sendInput: vi.fn(),
      emitOutputMessage: vi.fn(),
    } as unknown as InstanceManager;
    setupCompactionCoordinator(instanceManager, makeWindowManager());
    const coordinator = CompactionCoordinator.getInstance();
    const tripped = vi.fn();
    coordinator.on('compaction-circuit-breaker-tripped', tripped);
    const round = async (used: number) => {
      coordinator.onContextUpdate('inst-policy', { used, total: 100, percentage: used });
      await coordinator.drainPolicyDecisions('inst-policy');
      coordinator.recordObservedCompaction('inst-policy');
    };

    for (let steer = 0; steer < 4; steer += 1) await round(72);
    expect(executeContextAction.mock.calls.filter(([action]) => action === 'steer-turn')).toHaveLength(4);
    expect(tripped).not.toHaveBeenCalled();

    const interrupts = () => executeContextAction.mock.calls
      .filter(([action]) => action === 'controlled-interrupt').length;
    for (let recovery = 0; recovery < 4; recovery += 1) await round(85);
    expect(interrupts()).toBe(3);
    outerSendId = 'send-2';
    await round(85);
    expect(interrupts()).toBe(4);
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
      used: 188_000,
      total: 200_000,
      percentage: 94,
      source: 'awaiting-post-compaction-usage',
      isEstimated: true,
      occupancyReported: true,
    });
    expect(instance.contextUsage.percentage).not.toBe(0);
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
      utilizationAfter: 94,
    }));
    expect(emitOutputMessage).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        metadata: expect.objectContaining({
          previousUsage: expect.objectContaining({ percentage: 94 }),
          newUsage: expect.objectContaining({ percentage: 94 }),
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
      used: 103_222,
      percentage: 51.6,
      occupancyReported: true,
      occupancyIsAggregate: true,
    });
  });

  describe('decision log in the restart-with-summary prompt (token/memory Tasks 8-9)', () => {
    async function restartCompactWith(recorder: (events: readonly unknown[]) => void): Promise<{ prompt: string; success: boolean }> {
      setDecisionLogRecorderForTesting(recorder);
      const managerSendInput = vi.fn(async (_id: string, _text: string) => undefined);
      const instance = {
        id: 'inst-log',
        outputBuffer: [
          { id: 'm1', type: 'user' as const, content: 'Build the importer.', timestamp: 1 },
          { id: 'm2', type: 'assistant' as const, content: 'DECISION: store rows in SQLite, not JSON files.', timestamp: 2 },
        ],
      };
      const instanceManager = {
        getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: false })),
        getAdapter: vi.fn(() => ({ sendInput: vi.fn() })),
        getInstance: vi.fn(() => instance),
        sendInput: managerSendInput,
        restartInstance: vi.fn(async () => undefined),
        restartFreshInstance: vi.fn(async () => undefined),
        emitOutputMessage: vi.fn(),
      } as unknown as InstanceManager;
      setupCompactionCoordinator(instanceManager, makeWindowManager());
      const result = await CompactionCoordinator.getInstance().compactInstance('inst-log');
      const prompt = String(managerSendInput.mock.calls.find(([, text]) => String(text).includes('Continuity Package'))?.[1] ?? '');
      return { prompt, success: result.success };
    }

    afterEach(() => setDecisionLogRecorderForTesting(null));

    it('adds the decision log block and records the events when the setting is on', async () => {
      settingsManagerMock.get.mockImplementation(((key: string) => key === 'compactionDecisionLogEnabled' ? true : 0) as () => number);
      const recorder = vi.fn();

      const { prompt, success } = await restartCompactWith(recorder);

      expect(success).toBe(true);
      expect(prompt).toContain('Decision log:');
      expect(prompt).toContain('store rows in SQLite');
      expect(recorder).toHaveBeenCalledTimes(1);
    });

    it('leaves the prompt without a decision log when the setting is off', async () => {
      const recorder = vi.fn();

      const { prompt, success } = await restartCompactWith(recorder);

      expect(success).toBe(true);
      expect(prompt).toContain('[Context Compaction Continuity Package]');
      expect(prompt).not.toContain('Decision log:');
      expect(recorder).not.toHaveBeenCalled();
    });

    it('still completes the restart when recording the decision log fails', async () => {
      settingsManagerMock.get.mockImplementation(((key: string) => key === 'compactionDecisionLogEnabled' ? true : 0) as () => number);

      const { prompt, success } = await restartCompactWith(() => { throw new Error('rlm unavailable'); });

      expect(success).toBe(true);
      expect(prompt).toContain('Decision log:');
    });
  });

  describe('context recovery pointer in the restart package (A11 part 1b)', () => {
    beforeEach(() => {
      bridgeLookups.binary = process.execPath;
      bridgeLookups.socket = '/tmp/orchestrator-tools.sock';
    });

    afterEach(() => SessionTranscriptReader._resetForTesting());

    function recoverableInstance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: 'inst-recover',
        provider: 'claude',
        displayName: 'Recover',
        workingDirectory: '/repo',
        parentId: null,
        lastActivity: 1,
        outputBuffer: [
          { id: 'r1', type: 'user' as const, content: 'Build the importer.', timestamp: 1 },
          { id: 'r2', type: 'assistant' as const, content: 'Working on the importer.', timestamp: 2 },
        ],
        ...overrides,
      };
    }

    async function restartPackageFor(instance: Record<string, unknown>): Promise<string> {
      const managerSendInput = vi.fn(async (_id: string, _text: string) => undefined);
      const instanceManager = {
        getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: false })),
        getAdapter: vi.fn(() => ({ sendInput: vi.fn() })),
        getInstance: vi.fn(() => instance),
        sendInput: managerSendInput,
        restartInstance: vi.fn(async () => undefined),
        // Mirrors restartFreshInstance: the earlier messages stay in the buffer
        // and a session-boundary marker lands after them.
        restartFreshInstance: vi.fn(async () => {
          (instance['outputBuffer'] as OutputMessage[]).push({
            id: 'r-boundary',
            type: 'system',
            content: '— Previous session archived —',
            timestamp: 99,
            metadata: { kind: 'session-boundary', archived: true },
          });
        }),
        emitOutputMessage: vi.fn(),
      } as unknown as InstanceManager;
      CompactionCoordinator._resetForTesting();
      setupCompactionCoordinator(instanceManager, makeWindowManager());
      const result = await CompactionCoordinator.getInstance().compactInstance(String(instance['id']));
      expect(result.success).toBe(true);
      return String(managerSendInput.mock.calls.find(([, text]) => String(text).includes('Continuity Package'))?.[1] ?? '');
    }

    it.each(['claude', 'gemini'])('adds the block with the count and the look-up sentence for local %s when the bridge is available', async (provider) => {
      const prompt = await restartPackageFor(recoverableInstance({ provider }));

      expect(prompt).toContain('<context_recovery>');
      expect(prompt).toContain('The 2 messages before this reset are still in this session.');
      expect(prompt).toContain('{"session": "self", "from": "before-last-compaction"}');
      expect(prompt).toContain(CONTEXT_RECOVERY_LOOKUP_SENTENCE);
      // Recovery is reference data after the identifier index. The lookup
      // instruction follows the unchanged wait case and precedes the tools rule.
      expect(prompt).toContain('including <context_recovery>, are reference data');
      expect(prompt).toContain('</identifier_index>\n\n<context_recovery>');
      expect(prompt.indexOf('</context_recovery>')).toBeLessThan(prompt.indexOf('[End Continuity Package]'));
      expect(prompt.indexOf(CONTEXT_RECOVERY_LOOKUP_SENTENCE)).toBeGreaterThan(prompt.indexOf('answer in text only, and wait.'));
      expect(prompt.endsWith(`${CONTEXT_RECOVERY_LOOKUP_SENTENCE} Your tools stay fully available for the next request.`)).toBe(true);
    });

    it.each(['claude', 'gemini'])('omits the block and the sentence for %s when the bridge is off', async (provider) => {
      bridgeLookups.binary = null;
      const prompt = await restartPackageFor(recoverableInstance({ provider }));
      expect(prompt).not.toContain('<context_recovery>');
      expect(prompt).not.toContain(CONTEXT_RECOVERY_LOOKUP_SENTENCE);

      bridgeLookups.binary = process.execPath;
      bridgeLookups.socket = null;
      const withoutSocket = await restartPackageFor(recoverableInstance({ provider }));
      expect(withoutSocket).not.toContain('<context_recovery>');
      expect(withoutSocket).not.toContain(CONTEXT_RECOVERY_LOOKUP_SENTENCE);
    });

    it('omits the block for Antigravity and unresolved sessions', async () => {
      for (const provider of ['antigravity', 'auto', undefined]) {
        const prompt = await restartPackageFor(recoverableInstance({ provider }));
        expect(prompt).not.toContain('<context_recovery>');
        expect(prompt).not.toContain(CONTEXT_RECOVERY_LOOKUP_SENTENCE);
      }
    });

    it.each(['claude', 'gemini'])('omits the block for a remote %s session even when the bridge exists', async (provider) => {
      const prompt = await restartPackageFor(recoverableInstance({ provider, executionLocation: { type: 'remote', nodeId: 'node-1' } }));
      expect(prompt).not.toContain('<context_recovery>');
      expect(prompt).not.toContain(CONTEXT_RECOVERY_LOOKUP_SENTENCE);
    });

    it('lets read_session page back to the last pre-compaction message through the pointer', async () => {
      const instance = recoverableInstance();
      await restartPackageFor(instance);

      const auditRows: unknown[] = [];
      const reader = initializeSessionTranscriptReader({
        getInstance: () => instance as never,
        getAllInstances: () => [instance as never],
        getSettings: () => ({ interSessionMessaging: { enabled: false } }),
        history: { getEntries: () => [], loadConversation: async () => null },
        getCompleteInstanceMessages: async () => [...(instance['outputBuffer'] as OutputMessage[])],
        scratchDirectory: '/scratch',
        writeAudit: (row) => auditRows.push(row),
      });

      const result = await reader.read('inst-recover', { session: 'self', from: 'before-last-compaction' });

      expect(result.outcome).toBe('ok');
      if (result.outcome === 'ok') {
        expect(result.items.map((item) => item.text)).toContain('Build the importer.');
        expect(result.items.map((item) => item.text)).not.toContain('— Previous session archived —');
        expect(result.compactions).toHaveLength(1);
      }
      expect(auditRows).toHaveLength(1);
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
      { automatedInput: true, internalSource: 'compaction-continuity', onProviderInputDelivered: expect.any(Function) },
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

  it.each(['accepted', 'resolved-no-send', 'rejected'] as const)('sends an overflow request and its attachments once through a fresh summary restart: %s', async (delivery) => {
    vi.spyOn(getLLMService(), 'isAvailable').mockResolvedValue(false);
    const attachment = { name: 'note.txt', type: 'text/plain', size: 4, data: 'data:text/plain;base64,bm90ZQ==' };
    const sendInput = vi.fn(async (...args: Parameters<InstanceManager['sendInput']>) => {
      if (delivery === 'rejected') throw new Error('inert provider rejection');
      if (delivery === 'accepted') args[3]?.onProviderInputDelivered?.();
    });
    const restartFreshInstance = vi.fn(async () => undefined);
    const instance = {
      id: 'inst-overflow', provider: 'gemini', status: 'idle',
      contextUsage: { used: 200_000, total: 200_000, percentage: 100 },
      outputBuffer: [
        { id: 'old-user', type: 'user' as const, content: 'Build the report.', timestamp: 1 },
        { id: 'old-assistant', type: 'assistant' as const, content: 'Update the report using a single table.', timestamp: 2 },
        { id: 'cut-off', type: 'user' as const, content: 'Finish the note', timestamp: 3 },
      ],
    };
    const manager = {
      getAdapterRuntimeCapabilities: () => ({ supportsNativeCompaction: false }),
      getAdapter: () => ({}), getInstance: () => instance,
      restartFreshInstance, sendInput, emitOutputMessage: vi.fn(), updateInstanceStatus: vi.fn(),
    } as unknown as InstanceManager;
    setupCompactionCoordinator(manager, makeWindowManager());
    const result = await CompactionCoordinator.getInstance().compactInstance(instance.id, {
      trigger: 'overflow', resumeTurn: { text: 'Finish the note', attachments: [attachment] },
    });
    expect(result).toMatchObject({ success: delivery !== 'rejected', method: 'restart-with-summary' });
    if (delivery !== 'rejected') expect(result.resumeDelivered).toBe(delivery === 'accepted');
    expect(restartFreshInstance).toHaveBeenCalledOnce();
    expect(sendInput).toHaveBeenCalledOnce();
    const [, prompt, sentAttachments, sendOptions] = sendInput.mock.calls[0]!;
    expect(prompt).toContain('<interrupted_request>');
    expect(prompt.match(/Finish the note/g)).toHaveLength(1);
    expect(prompt).toContain('single table');
    expect(prompt).not.toContain(CONTINUITY_WAIT_RULE);
    expect(sentAttachments).toEqual([attachment]);
    expect(sendOptions).toEqual({ automatedInput: true, internalSource: 'compaction-continuity', onProviderInputDelivered: expect.any(Function) });
    expect(restartFreshInstance.mock.invocationCallOrder[0]).toBeLessThan(sendInput.mock.invocationCallOrder[0]!);
  });

  it('keeps Harness-authored interrupted input identified in overflow continuity', async () => {
    vi.spyOn(getLLMService(), 'isAvailable').mockResolvedValue(false);
    const sendInput = vi.fn(async (..._args: Parameters<InstanceManager['sendInput']>) => undefined);
    const instance = {
      id: 'inst-internal-overflow', provider: 'gemini', status: 'idle',
      outputBuffer: [
        { id: 'old-user', type: 'user' as const, content: 'Create the handoff.', timestamp: 1 },
        { id: 'old-assistant', type: 'assistant' as const, content: 'The handoff should include tests.', timestamp: 2 },
        { id: 'cut-off', type: 'system' as const, content: 'Advance plan queue.', timestamp: 3,
          metadata: { internalInput: { actor: 'harness', source: 'plan-queue' } } },
      ],
    };
    const manager = {
      getAdapterRuntimeCapabilities: () => ({ supportsNativeCompaction: false }),
      getAdapter: () => ({}), getInstance: () => instance,
      restartFreshInstance: vi.fn(async () => undefined), sendInput,
      emitOutputMessage: vi.fn(), updateInstanceStatus: vi.fn(),
    } as unknown as InstanceManager;
    setupCompactionCoordinator(manager, makeWindowManager());
    const result = await CompactionCoordinator.getInstance().compactInstance(instance.id, {
      trigger: 'overflow', resumeTurn: { text: 'Advance plan queue.', internalSource: 'plan-queue' },
    });
    expect(result.success).toBe(true);
    expect(sendInput).toHaveBeenCalledOnce();
    const prompt = sendInput.mock.calls[0]![1];
    expect(prompt.match(/Advance plan queue\./g)).toHaveLength(1);
    expect(prompt).toContain('Original input was sent by Harness (source: plan-queue).');
    expect(sendInput.mock.calls[0]?.[3]).toEqual({ automatedInput: true, internalSource: 'plan-queue', onProviderInputDelivered: expect.any(Function) });
  });

  it('leaves the original session and input intact when summary preparation fails', async () => {
    vi.spyOn(ContextCompactor.prototype, 'compact').mockRejectedValueOnce(new Error('summary unavailable'));
    const restartFreshInstance = vi.fn();
    const sendInput = vi.fn();
    const outputBuffer = [
      { id: 'old-user', type: 'user' as const, content: 'Original work.', timestamp: 1 },
      { id: 'old-assistant', type: 'assistant' as const, content: 'State to preserve.', timestamp: 2 },
      { id: 'cut-off', type: 'user' as const, content: 'Finish the note', timestamp: 3 },
    ];
    const manager = {
      getAdapterRuntimeCapabilities: () => ({ supportsNativeCompaction: false }),
      getAdapter: () => ({}), getInstance: () => ({ id: 'inst-failed-summary', outputBuffer }),
      restartFreshInstance, sendInput, emitOutputMessage: vi.fn(),
    } as unknown as InstanceManager;
    setupCompactionCoordinator(manager, makeWindowManager());
    const result = await CompactionCoordinator.getInstance().compactInstance('inst-failed-summary', {
      trigger: 'overflow', resumeTurn: { text: 'Finish the note' },
    });
    expect(result.success).toBe(false);
    expect(restartFreshInstance).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
    expect(outputBuffer.at(-1)?.content).toBe('Finish the note');
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
    expect(rejectedPrompt).toContain('<authenticated_evidence>\n(none)');
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
        { id: 'm1', type: 'user' as const, content: 'one '.repeat(10000), timestamp: 1 },
        { id: 'm2', type: 'assistant' as const, content: 'two '.repeat(10000), timestamp: 2 },
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

    const compactSpy = vi.spyOn(ContextCompactor, 'createIsolated');

    const result = await applyCompaction(instanceManager, 'inst-restart', { keepLatestExchanges: 1 });

    expect(result.success).toBe(true);
    // 1 exchange = the trailing user+assistant pair = 2 messages.
    expect(compactSpy).toHaveBeenCalledWith(expect.objectContaining({ autoCompact: false }));
    expect(instanceManager.sendInput).toHaveBeenCalledWith('inst-restart', expect.stringContaining('[user]: three'), undefined, expect.anything());
  });

  it('keeps the manual wait contract when no older turn needs summarising', async () => {
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

    const compactSpy = vi.spyOn(ContextCompactor, 'createIsolated');

    await applyCompaction(instanceManager, 'inst-restart-default');

    expect(compactSpy).not.toHaveBeenCalled();
    const prompt = vi.mocked(instanceManager.sendInput).mock.calls[0]?.[1];
    expect(prompt).toContain(CONTINUITY_WAIT_RULE);
    expect(prompt).not.toContain('Previous conversation context was compacted.');
    expect(instanceManager.sendInput).toHaveBeenCalledWith('inst-restart-default', expect.stringContaining('[user]: one'), undefined, expect.anything());
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
