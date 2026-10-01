import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import { createDefaultContextInheritance } from '../../../shared/types/supervision.types';
import { AutoTitleService } from '../auto-title-service';
import { InstanceTerminationCoordinator, type InstanceTerminationDeps } from './instance-termination';

const { mockAuxGenerate, mockCreateAdapter, mockResolveCliType, mockIsCliAvailable } = vi.hoisted(() => {
  const sendMessage = vi.fn();

  return {
    mockAuxGenerate: vi.fn(),
    mockCreateAdapter: vi.fn(() => ({
      sendMessage,
    })),
    mockResolveCliType: vi.fn(),
    mockIsCliAvailable: vi.fn(),
  };
});

vi.mock('../../cli/adapters/adapter-factory', () => ({
  resolveCliType: mockResolveCliType,
}));

vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({
    createAdapter: mockCreateAdapter,
  })),
}));

vi.mock('../../cli/cli-detection', () => ({
  isCliAvailable: mockIsCliAvailable,
}));

vi.mock('../../rlm/auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: vi.fn(() => ({
    generate: mockAuxGenerate,
  })),
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => mockLog),
}));

const { mockFilterProvidersForAutomation } = vi.hoisted(() => ({
  mockFilterProvidersForAutomation: vi.fn((providers: readonly string[]) => [...providers]),
}));

vi.mock('../../providers/automation-provider-exclusions', () => ({
  filterProvidersForAutomation: mockFilterProvidersForAutomation,
}));

vi.mock('../instance-provider-limit-handler', () => ({ getInstanceProviderLimitHandler: () => ({ release: vi.fn() }) }));
vi.mock('../instance-auth-repair-handler', () => ({ getInstanceAuthRepairHandler: () => ({ forget: vi.fn() }) }));
vi.mock('../../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../../session/session-turn-supervisor', () => ({ deleteTurnSupervisor: vi.fn() }));
vi.mock('./respawn-circuit-breaker', () => ({ deleteCircuitBreaker: vi.fn() }));
vi.mock('./session-branch-merge', () => ({ mergeSessionBranchToMain: vi.fn().mockResolvedValue({ merged: false }) }));

describe('shared termination runtime', () => {
  afterEach(() => AutoTitleService._resetForTesting());

  it.each([false, true])('cancels pending naming through shared termination (graceful=%s)', async (graceful) => {
    AutoTitleService._resetForTesting();
    let finish!: (result: unknown) => void;
    mockAuxGenerate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const apply = vi.fn();
    const opening = AutoTitleService.getInstance().maybeGenerateTitle('closing', 'Work Finder watchdog faults', apply);
    const instance: Instance = {
      id: 'closing', displayName: 'Work Finder watchdog faults', createdAt: 1,
      historyThreadId: 'closing-thread', status: 'idle', parentId: null,
      workingDirectory: '/tmp/title-runtime', outputBuffer: [], childrenIds: [],
      supervisorNodeId: 'closing-supervisor', depth: 0, terminationPolicy: 'orphan-children',
      contextInheritance: createDefaultContextInheritance(), agentId: 'build', agentMode: 'build',
      planMode: { enabled: false, state: 'off' }, contextUsage: { used: 0, total: 200_000, percentage: 0 },
      lastActivity: 1, processId: null, providerSessionId: 'closing-provider-session',
      sessionId: 'closing-provider-session', restartEpoch: 0, yoloMode: false,
      launchMode: 'orchestrated', provider: 'claude', executionLocation: { type: 'local' },
      outputBufferMaxSize: 1000, totalTokensUsed: 0, subscribedTo: [], communicationTokens: new Map(),
      errorCount: 0, requestCount: 0, restartCount: 0,
    };
    const deps: InstanceTerminationDeps = {
      getAdapter: () => undefined, getInstance: () => instance,
      deleteAdapter: () => true, deleteInstance: () => true,
      forceReleaseSessionMutex: () => {}, removeActivityDetector: () => {}, clearRecoveryHistory: () => {},
      transitionState: (i, status) => { i.status = status; }, terminateChild: async () => {},
      unregisterSupervisor: () => {}, unregisterOrchestration: () => {}, clearFirstMessageTracking: () => {},
      endRlmSession: () => {}, deleteOutputStorage: async () => {}, archiveInstance: async () => {},
      importTranscript: () => {}, emitRemoved: () => {},
    };
    await new InstanceTerminationCoordinator(deps).terminateInstance('closing', graceful, { skipTranscriptMining: true, preserveDurableProviderResume: true });
    finish({ text: 'Work Finder repaired', decision: { source: 'local', allowFrontierFallback: false } });
    await opening;
    expect(instance.status).toBe('terminated');
    expect(apply.mock.calls.filter(([, , source]) => source === 'ai')).toEqual([]);
  });
});
