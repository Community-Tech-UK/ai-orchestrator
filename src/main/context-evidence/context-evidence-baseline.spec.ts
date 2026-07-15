import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

const electronMocks = vi.hoisted(() => ({
  getPath: vi.fn(() => '/tmp/aio-context-evidence-baseline'),
}));

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
}));

const hookMocks = vi.hoisted(() => ({
  triggerHooks: vi.fn().mockResolvedValue(undefined),
  triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }),
}));

vi.mock('electron', () => ({
  app: { getPath: electronMocks.getPath },
}));

vi.mock('fs/promises', () => fsMocks);

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }),
  }),
}));

vi.mock('../memory', () => ({
  getOutputStorageManager: () => ({
    storeMessages: vi.fn(),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../hooks/hook-manager', () => ({
  getHookManager: () => hookMocks,
}));

vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));

vi.mock('../core/error-recovery', () => ({
  getErrorRecoveryManager: () => ({
    classifyError: vi.fn(() => ({ category: 'unknown', technicalDetails: '' })),
  }),
}));

vi.mock('../session/session-continuity', () => ({
  getSessionContinuityManagerIfInitialized: () => ({
    writeThroughIdentity: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { OutputPersistenceManager } from '../context/output-persistence';
import { Microcompact } from '../context/microcompact';
import { ContextCompactor } from '../context/context-compactor';
import { ProviderRuntimeEventBus, type PendingEnvelope } from '../providers/provider-runtime-event-bus';
import { InstanceCommunicationManager } from '../instance/instance-communication';
import { CodexContextCostController } from '../cli/adapters/codex/context-cost-controller';
import { CodexTurnCostGovernor } from '../cli/adapters/codex/turn-cost-governor';

interface IncidentManifest {
  schemaVersion: 1;
  incident: {
    initialInputTokens: number;
    modelRequests: number;
    currentOccupancyTokens: number;
    contextWindowTokens: number;
    cumulativeProcessingTokens: number;
  };
  controlledUngovernedBaseline: {
    cumulativeInputTokens: number;
    cachedInputTokens: number;
    cacheAssumption: string;
  };
  generator: {
    algorithm: 'quotient-remainder-ascii';
    groups: {
      category: string;
      toolName: string;
      callCount: number;
      externalizableCount: number;
      resultCharacters: number;
      fillCharacter: string;
    }[];
  };
}

interface ExpandedCall {
  category: string;
  toolName: string;
  externalizable: boolean;
  result: string;
}

function readIncidentManifest(): { raw: string; manifest: IncidentManifest } {
  const raw = readFileSync(
    resolve(
      process.cwd(),
      'src/main/context-evidence/__fixtures__/codex-44-call-incident.manifest.json',
    ),
    'utf8',
  );
  return { raw, manifest: JSON.parse(raw) as IncidentManifest };
}

function expandIncident(manifest: IncidentManifest): ExpandedCall[] {
  return manifest.generator.groups.flatMap((group) => {
    const baseCharacters = Math.floor(group.resultCharacters / group.callCount);
    const remainder = group.resultCharacters % group.callCount;
    return Array.from({ length: group.callCount }, (_, index) => ({
      category: group.category,
      toolName: group.toolName,
      externalizable: index < group.externalizableCount,
      result: group.fillCharacter.repeat(baseCharacters + (index < remainder ? 1 : 0)),
    }));
  });
}

class FakeAdapter extends EventEmitter {
  sendInput = vi.fn().mockResolvedValue(undefined);
  terminate = vi.fn().mockResolvedValue(undefined);

  getName(): string {
    return 'codex-cli';
  }

  getSessionId(): string | null {
    return null;
  }
}

function createInstance(): Instance {
  return {
    id: 'incident-instance',
    displayName: 'Incident characterization',
    createdAt: 1,
    historyThreadId: 'incident-thread',
    parentId: null,
    childrenIds: [],
    supervisorNodeId: '',
    workerNodeId: undefined,
    depth: 0,
    terminationPolicy: 'terminate-children',
    contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build',
    agentMode: 'build',
    planMode: { enabled: false, state: 'off' },
    status: 'busy',
    contextUsage: { used: 246_825, total: 258_400, percentage: 95.52 },
    lastActivity: 1,
    processId: 1,
    sessionId: 'incident-session',
    workingDirectory: '/tmp/aio-context-evidence-baseline/project',
    yoloMode: false,
    provider: 'codex',
    currentModel: 'gpt-5.3-codex',
    outputBuffer: [],
    outputBufferMaxSize: 100,
    communicationTokens: new Map(),
    subscribedTo: [],
    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
    restartEpoch: 0,
  };
}

async function flushAsyncListeners(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('provider-agnostic context evidence incident baseline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookMocks.triggerHooks.mockResolvedValue(undefined);
    hookMocks.triggerLifecycleHooks.mockResolvedValue({ blocked: false });
    OutputPersistenceManager._resetForTesting();
    ContextCompactor._resetForTesting();
  });

  it('expands the compact sanitized manifest to the exact incident shape', () => {
    const { raw, manifest } = readIncidentManifest();
    const calls = expandIncident(manifest);
    const resultText = calls.map((call) => call.result).join('');

    expect(raw.length).toBeLessThan(4_000);
    expect(raw).not.toMatch(/(?:sk-|Bearer\s|password|private[_-]?key)/i);
    expect(manifest.generator.algorithm).toBe('quotient-remainder-ascii');
    expect(calls).toHaveLength(44);
    expect(calls.filter((call) => call.externalizable)).toHaveLength(25);
    expect(resultText).toHaveLength(900_532);
    expect(Buffer.byteLength(resultText, 'utf8')).toBe(900_532);
    expect(
      Object.fromEntries(
        manifest.generator.groups.map((group) => [group.category, group.resultCharacters]),
      ),
    ).toEqual({ web: 580_831, 'shell-file-database': 278_427, 'tool-discovery': 41_274 });
  });

  it('freezes the controlled ungoverned cumulative and cached-input baseline', () => {
    const { manifest } = readIncidentManifest();

    expect(manifest.incident).toEqual({
      initialInputTokens: 20_344,
      modelRequests: 45,
      currentOccupancyTokens: 246_825,
      contextWindowTokens: 258_400,
      cumulativeProcessingTokens: 5_693_312,
    });
    expect(manifest.controlledUngovernedBaseline).toEqual({
      cumulativeInputTokens: 5_693_312,
      cachedInputTokens: 5_446_487,
      cacheAssumption: 'perfect-prefix-reuse; current occupancy excluded from cached input',
    });
    expect(
      manifest.controlledUngovernedBaseline.cumulativeInputTokens
        - manifest.controlledUngovernedBaseline.cachedInputTokens,
    ).toBe(manifest.incident.currentOccupancyTokens);
  });

  it('preserves full output when a legacy caller has no canonical capture ownership', async () => {
    const rawOutput = `${'h'.repeat(2_000)}${'m'.repeat(1_000)}${'t'.repeat(1_000)}`;
    const manager = OutputPersistenceManager.getInstance();
    manager.configure({ thresholds: { baseline_tool: 10 } });

    const preview = await manager.maybeExternalize('baseline_tool', rawOutput);

    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(preview).toBe(rawOutput);
    expect(preview).not.toContain('[Full output saved:');
  });

  it('regresses the incident by retaining old output without authenticated complete evidence', () => {
    const originalOutput = 'complete old tool output';
    const result = new Microcompact({ recentTurnsToProtect: 1, minSavingsTokens: 1 }).compact([
      {
        id: 'old', role: 'assistant', content: '', tokenCount: 0, timestamp: 1,
        toolCalls: [{ id: 'call-old', name: 'Read', input: '{}', output: originalOutput, inputTokens: 1, outputTokens: 1_000 }],
      },
      { id: 'recent', role: 'assistant', content: 'recent', tokenCount: 1, timestamp: 2 },
    ]);
    const compactedOutput = result.turns[0].toolCalls?.[0].output;

    expect(result.skipped).toBe(true);
    expect(compactedOutput).toBe(originalOutput);
    expect(JSON.stringify(result.turns)).toContain(originalOutput);
  });

  it('regresses the incident by retaining prunable output without authenticated evidence', () => {
    const compactor = ContextCompactor.getInstance();
    compactor.updateConfig({ autoCompact: false, maxContextTokens: 1_000_000 });
    for (let index = 0; index < 7; index++) {
      compactor.addTurn({
        role: 'assistant',
        content: '',
        tokenCount: 0,
        toolCalls: [{
          id: `call-${index}`,
          name: 'Read',
          input: '{}',
          output: `complete-result-${index}`,
          inputTokens: 0,
          outputTokens: 10_000,
        }],
      });
    }

    const pruneResult = compactor.pruneToolOutputs();
    const oldestOutput = compactor.getState().turns[0].toolCalls?.[0].output;

    expect(pruneResult).toEqual({ prunedTokens: 0, prunedTurns: 0 });
    expect(oldestOutput).toBe('complete-result-0');
  });

  it('records that duplicate raw-backed critical ingress is emitted and captured twice', () => {
    const emitted: unknown[] = [];
    const captured: unknown[] = [];
    const bus = new ProviderRuntimeEventBus((envelope) => emitted.push(envelope), {
      onRawBackedEvent: (envelope) => captured.push(envelope),
    });
    const pending: PendingEnvelope = {
      timestamp: 1,
      provider: 'codex',
      instanceId: 'incident-instance',
      raw: { source: 'adapter-event:tool_result', payload: { id: 'same-native-result' } },
      event: { kind: 'tool_result', toolName: 'web', toolUseId: 'same-call', output: 'same result', success: true },
    };

    bus.enqueue(pending);
    bus.enqueue({ ...pending });

    expect(emitted).toHaveLength(2);
    expect(captured).toHaveLength(2);
    expect(emitted).toMatchObject([{ seq: 0 }, { seq: 1 }]);
    expect(captured).toMatchObject([{ seq: 0 }, { seq: 1 }]);
  });

  it('records that completion can overtake an async tool-result output handler', async () => {
    let releasePostToolUse: (() => void) | undefined;
    const postToolUsePending = new Promise<void>((resolve) => { releasePostToolUse = resolve; });
    hookMocks.triggerLifecycleHooks.mockImplementation((name: string) =>
      name === 'PostToolUse'
        ? postToolUsePending.then(() => ({ blocked: false }))
        : Promise.resolve({ blocked: false }),
    );
    const instance = createInstance();
    const adapter = new FakeAdapter() as unknown as CliAdapter;
    const order: string[] = [];
    const manager = new InstanceCommunicationManager({
      getInstance: (id) => id === instance.id ? instance : undefined,
      getAdapter: (id) => id === instance.id ? adapter : undefined,
      setAdapter: vi.fn(),
      deleteAdapter: vi.fn(),
      queueUpdate: vi.fn(),
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      emitProviderRuntimeEvent: (_id, event) => {
        if (event.kind === 'complete') order.push('complete');
      },
    });
    manager.on('output', () => order.push('output'));
    manager.setupAdapterEvents(instance.id, adapter);
    const toolResult: OutputMessage = {
      id: 'tool-result',
      timestamp: 1,
      type: 'tool_result',
      content: 'tool finished',
      metadata: { name: 'web' },
    };

    (adapter as unknown as EventEmitter).emit('output', toolResult);
    (adapter as unknown as EventEmitter).emit('complete', {
      id: 'complete', role: 'assistant', content: 'done',
    });

    expect(order).toEqual(['complete']);
    releasePostToolUse?.();
    await flushAsyncListeners();
    expect(order).toEqual(['complete', 'output']);
  });

  it('records Codex cumulative telemetry without restoring an adapter-owned decision', () => {
    const { manifest } = readIncidentManifest();
    const decision = new CodexTurnCostGovernor().observe({
      cumulativeTokens: manifest.incident.cumulativeProcessingTokens,
      contextWindow: manifest.incident.contextWindowTokens,
    });
    expect(decision).not.toHaveProperty('action');
    expect(decision.multiple).toBeCloseTo(22.033, 3);

    const interrupt = vi.fn(() => ({ status: 'unsupported' as const }));
    const emitSystem = vi.fn();
    const recordObservation = vi.fn();
    const controller = new CodexContextCostController({
      compactionTimeoutMs: 1,
      interrupt,
      getCompactionTarget: () => null,
      emitSystem,
      recordObservation,
    });
    controller.observe(
      manifest.incident.cumulativeProcessingTokens,
      manifest.incident.contextWindowTokens,
    );

    expect(interrupt).not.toHaveBeenCalled();
    expect(emitSystem).not.toHaveBeenCalled();
    expect(recordObservation).toHaveBeenCalledWith(expect.objectContaining({
      multiple: expect.closeTo(22.033, 3),
    }));
  });
});
