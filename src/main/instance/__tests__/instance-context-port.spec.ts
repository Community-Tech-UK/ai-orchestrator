import { describe, it, expect, vi } from 'vitest';
import type { InstanceContextPort } from '../instance-context-port';

// ── Minimal module-level mocks ──────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test'), isPackaged: false },
}));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    store: {},
    get: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
    path: '/tmp/test/settings.json',
  })),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  getLogManager: vi.fn(() => ({ getLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })) })),
  _resetLogManagerForTesting: vi.fn(),
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    get: vi.fn(),
    getAll: vi.fn(() => ({ persistSessionContent: true, defaultCli: 'auto' })),
    on: vi.fn(),
    emit: vi.fn(),
  })),
  SettingsManager: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    getAll: vi.fn(() => ({})),
    on: vi.fn(),
  })),
}));

vi.mock('../../rlm/context-manager', () => ({
  RLMContextManager: {
    getInstance: vi.fn(() => ({
      getStore: vi.fn(),
      newSession: vi.fn(() => 'sess-1'),
      endSession: vi.fn(),
      addSection: vi.fn(),
    })),
  },
}));

vi.mock('../../memory', () => ({
  getUnifiedMemory: vi.fn(() => ({ retrieve: vi.fn(), ingest: vi.fn() })),
  getMemoryMonitor: vi.fn(() => ({ on: vi.fn(), start: vi.fn(), stop: vi.fn() })),
  getOutputStorageManager: vi.fn(() => ({ store: vi.fn(), getRecent: vi.fn() })),
}));

vi.mock('../../context/jit-loader', () => ({
  getJITLoader: vi.fn(() => ({ registerLoader: vi.fn(), load: vi.fn() })),
  FileSystemLoader: vi.fn(),
  MemoryStoreLoader: vi.fn(),
}));

// Mocks needed for InstanceManager transitive imports
vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({ createAdapter: vi.fn() })),
}));
vi.mock('../../observability/otel-setup', () => ({ getOrchestratorTracer: vi.fn(() => ({ startSpan: vi.fn(() => ({ end: vi.fn() })), startActiveSpan: vi.fn((_n: string, _a: unknown, fn: (s: { end: () => void; setStatus: () => void }) => unknown) => fn({ end: vi.fn(), setStatus: vi.fn() })) })) }));
vi.mock('../../observability', () => ({}));
vi.mock('../../session/session-continuity', () => ({ getSessionContinuityManager: vi.fn(() => ({ startTracking: vi.fn(), stopTracking: vi.fn(), updateState: vi.fn(), addConversationEntry: vi.fn() })) }));
vi.mock('../../session/resume-hint', () => ({ getResumeHintManager: vi.fn(() => ({ getHint: vi.fn(), saveHint: vi.fn() })) }));
vi.mock('../../util/cleanup-registry', () => ({ registerCleanup: vi.fn() }));
vi.mock('../../storage/project-storage-paths', () => ({ getProjectStoragePaths: vi.fn(() => ({ getGlobalDomainRoot: vi.fn(() => '/tmp/test'), getSessionEventLogPath: vi.fn(() => '/tmp/test/events.ndjson') })) }));
vi.mock('../../session/session-persistence-queue', () => ({ getSessionPersistenceQueue: vi.fn(() => ({ enqueueEvent: vi.fn(), enqueueSave: vi.fn(), shutdown: vi.fn() })) }));
vi.mock('../../orchestration/resource-governor', () => ({ getResourceGovernor: vi.fn(() => ({ getCreationBlockReason: vi.fn(() => null), on: vi.fn() })) }));
vi.mock('../../orchestration/orchestration-handler', () => ({ OrchestrationHandler: vi.fn().mockImplementation(() => ({ on: vi.fn(), emit: vi.fn() })) }));
vi.mock('../warm-start-manager', () => ({ WarmStartManager: vi.fn().mockImplementation(() => ({ preWarm: vi.fn(), getWarmAdapter: vi.fn(), returnAdapter: vi.fn() })) }));
vi.mock('../stuck-process-detector', () => ({ StuckProcessDetector: vi.fn().mockImplementation(() => ({ onProcessStarted: vi.fn(), onProcessEnded: vi.fn(), on: vi.fn() })) }));
vi.mock('../auto-title-service', () => ({ getAutoTitleService: vi.fn(() => ({ maybeGenerate: vi.fn(), clearInstance: vi.fn() })) }));
vi.mock('../instance-deps', () => ({ productionCoreDeps: {} }));
vi.mock('../../cli/cli-detection', () => ({ detectAllClis: vi.fn().mockResolvedValue([]) }));
vi.mock('../../process/load-balancer', () => ({ getLoadBalancer: vi.fn(() => ({ updateMetrics: vi.fn(), removeMetrics: vi.fn() })) }));
vi.mock('../../state', () => ({ getAppStore: vi.fn(), addInstance: vi.fn(), removeInstance: vi.fn(), updateInstance: vi.fn(), setGlobalState: vi.fn() }));
vi.mock('../../util/slow-operations', () => ({ measureAsync: vi.fn((_n: string, fn: () => unknown) => fn()), SlowOperationMonitor: vi.fn().mockImplementation(() => ({ record: vi.fn() })) }));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InstanceContextPort', () => {
  it('InstanceContextManager structurally satisfies InstanceContextPort', async () => {
    const { InstanceContextManager } = await import('../instance-context');
    const mgr = new InstanceContextManager();
    const port: InstanceContextPort = mgr;

    expect(typeof port.initializeRlm).toBe('function');
    expect(typeof port.endRlmSession).toBe('function');
    expect(typeof port.ingestToRLM).toBe('function');
    expect(typeof port.ingestToUnifiedMemory).toBe('function');
    expect(typeof port.ingestInitialOutputToRlm).toBe('function');
    expect(typeof port.calculateContextBudget).toBe('function');
    expect(typeof port.buildRlmContext).toBe('function');
    expect(typeof port.buildUnifiedMemoryContext).toBe('function');
    expect(typeof port.formatRlmContextBlock).toBe('function');
    expect(typeof port.formatUnifiedMemoryContextBlock).toBe('function');
    expect(typeof port.compactContext).toBe('function');
  });

  it('InstanceManager can be constructed with a fake context port', async () => {
    const { InstanceManager } = await import('../instance-manager');

    const fakePort: InstanceContextPort = {
      initializeRlm: vi.fn().mockResolvedValue(undefined),
      endRlmSession: vi.fn(),
      ingestInitialOutputToRlm: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      calculateContextBudget: vi.fn().mockReturnValue({
        rlmMaxTokens: 1000, rlmTopK: 5,
        unifiedMaxTokens: 500, canInjectRlm: true, canInjectUnified: true,
      }),
      buildRlmContext: vi.fn().mockResolvedValue(null),
      buildUnifiedMemoryContext: vi.fn().mockResolvedValue(null),
      formatRlmContextBlock: vi.fn().mockReturnValue(null),
      formatUnifiedMemoryContextBlock: vi.fn().mockReturnValue(null),
      compactContext: vi.fn().mockResolvedValue(undefined),
    };

    expect(() => new InstanceManager(undefined, fakePort)).not.toThrow();
  });

  it('formatRlmContextBlock returns null for null input', async () => {
    const { InstanceContextManager } = await import('../instance-context');
    expect(new InstanceContextManager().formatRlmContextBlock(null)).toBeNull();
  });

  it('formatUnifiedMemoryContextBlock returns null for null input', async () => {
    const { InstanceContextManager } = await import('../instance-context');
    expect(new InstanceContextManager().formatUnifiedMemoryContextBlock(null)).toBeNull();
  });
});
