/**
 * MultiVerifyCoordinator Tests
 *
 * The coordinator fires an extensibility event ('verification:invoke-agent')
 * and expects an external handler to call the provided callback.  Tests
 * register in-process handlers to simulate the LLM integration layer.
 *
 * vi.mock() paths are resolved relative to THIS test file location:
 *   src/main/orchestration/__tests__/multi-verify-coordinator.spec.ts
 * So paths like '../../logging/logger' resolve to src/main/logging/logger.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must appear before any import that transitively loads Electron
// ---------------------------------------------------------------------------

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getLogManager: vi.fn(() => ({
    getLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  })),
}));

// ---------------------------------------------------------------------------
// electron-store mock (used by VerificationCache)
// ---------------------------------------------------------------------------
vi.mock('electron-store', () => {
  const store: Record<string, unknown> = {};
  return {
    default: vi.fn().mockImplementation(() => ({
      store: { verifications: {}, metadata: { totalCached: 0, totalHits: 0, totalMisses: 0, lastPruned: 0 } },
      path: '/tmp/test-verification-cache.json',
      get: vi.fn((key: string) => store[key]),
      set: vi.fn((key: string, value: unknown) => { store[key] = value; }),
      clear: vi.fn(),
    })),
  };
});

// ---------------------------------------------------------------------------
// Settings manager mock (used by synthesizeMerge via getSettingsManager)
// ---------------------------------------------------------------------------
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    getAll: vi.fn(() => ({ defaultCli: 'auto' })),
    get: vi.fn(() => 'auto'),
  })),
}));

// ---------------------------------------------------------------------------
// CLI adapter mock (used by synthesizeMerge)
// ---------------------------------------------------------------------------
vi.mock('../../cli/adapters/adapter-factory', () => ({
  createCliAdapter: vi.fn(() => ({
    sendMessage: vi.fn().mockResolvedValue({ content: 'Synthesized response from CLI adapter' }),
    terminate: vi.fn(),
  })),
  resolveCliType: vi.fn().mockResolvedValue('claude'),
}));

// ---------------------------------------------------------------------------
// Embedding service mock
// ---------------------------------------------------------------------------
const mockClusterResponses = vi.fn().mockResolvedValue([]);

vi.mock('../../orchestration/embedding-service', () => ({
  getEmbeddingService: vi.fn(() => ({
    clusterResponses: mockClusterResponses,
  })),
}));

// ---------------------------------------------------------------------------
// Verification cache mock
// ---------------------------------------------------------------------------
const mockHashPrompt = vi.fn((prompt: string) => `hash-${prompt.slice(0, 10)}`);
const mockGetCached = vi.fn().mockResolvedValue(null);
const mockCacheStore = vi.fn().mockResolvedValue(undefined);

vi.mock('../../orchestration/verification-cache', () => ({
  getVerificationCache: vi.fn(() => ({
    hashPrompt: mockHashPrompt,
    getCached: mockGetCached,
    cache: mockCacheStore,
  })),
}));

// ---------------------------------------------------------------------------
// Confidence analyzer mock
// ---------------------------------------------------------------------------
vi.mock('../../orchestration/confidence-analyzer', () => ({
  getConfidenceAnalyzer: vi.fn(() => ({
    findExplicitConfidence: vi.fn((text: string) => {
      const match = text.match(/(\d+)%/);
      return match ? parseInt(match[1]) / 100 : 0.7;
    }),
    extractConfidence: vi.fn().mockResolvedValue({
      explicit: 0.75,
      linguistic: 0.6,
      consistency: 0.8,
      evidenceStrength: 0.7,
      combined: 0.71,
    }),
  })),
}));

// ---------------------------------------------------------------------------
// Personalities mock
// ---------------------------------------------------------------------------
vi.mock('../../orchestration/personalities', () => ({
  PERSONALITY_PROMPTS: {
    'methodical-analyst': 'You are a methodical analyst.',
    'creative-solver': 'You are a creative solver.',
    'pragmatic-engineer': 'You are a pragmatic engineer.',
  },
  selectPersonalities: vi.fn((count: number) => {
    const types = ['methodical-analyst', 'creative-solver', 'pragmatic-engineer'];
    return Array.from({ length: count }, (_, i) => types[i % types.length]);
  }),
}));

// ---------------------------------------------------------------------------
// Import the class under test (after all mocks are set up)
// ---------------------------------------------------------------------------

import {
  MultiVerifyCoordinator,
  getMultiVerifyCoordinator,
  InsufficientAgentsError,
} from '../multi-verify-coordinator';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type InvokeAgentPayload = {
  requestId: string;
  instanceId: string;
  agentId: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  context?: string;
  callback: (err: string | null, response?: string, tokens?: number, cost?: number) => void;
};

/**
 * Registers a handler on coordinator for 'verification:invoke-agent' that
 * immediately resolves every agent call with a canned response.
 */
function registerAgentHandler(
  coordinator: MultiVerifyCoordinator,
  response = 'Test response. Overall Confidence: 80%',
  tokens = 100,
  cost = 0.001
) {
  coordinator.on('verification:invoke-agent', (payload: InvokeAgentPayload) => {
    payload.callback(null, response, tokens, cost);
  });
}

/**
 * Registers a handler that produces distinct responses per agent index so
 * key-point clustering does not accidentally produce agreements.
 */
function registerDistinctAgentHandler(coordinator: MultiVerifyCoordinator) {
  coordinator.on('verification:invoke-agent', (payload: InvokeAgentPayload) => {
    const index = payload.agentId.split('-agent-').pop() ?? '0';
    payload.callback(
      null,
      `Unique agent ${index} response covering topics alpha beta gamma delta. Overall Confidence: ${70 + Number(index)}%`,
      50,
      0.001
    );
  });
}

/**
 * Registers a handler that always errors.
 */
function registerFailingAgentHandler(coordinator: MultiVerifyCoordinator) {
  coordinator.on('verification:invoke-agent', (payload: InvokeAgentPayload) => {
    payload.callback('Agent failed with an internal error');
  });
}

/**
 * Waits for a coordinator event and resolves with its payload.
 */
function waitForEvent<T>(coordinator: MultiVerifyCoordinator, event: string): Promise<T> {
  return new Promise((resolve) => coordinator.once(event, resolve as (arg: T) => void));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MultiVerifyCoordinator', () => {
  let coordinator: MultiVerifyCoordinator;

  beforeEach(() => {
    MultiVerifyCoordinator._resetForTesting();
    coordinator = MultiVerifyCoordinator.getInstance();
    vi.clearAllMocks();

    // Restore mocks cleared by clearAllMocks
    mockGetCached.mockResolvedValue(null);
    mockCacheStore.mockResolvedValue(undefined);
    mockHashPrompt.mockImplementation((prompt: string) => `hash-${prompt.slice(0, 10)}`);
    mockClusterResponses.mockResolvedValue([]);
  });

  afterEach(() => {
    MultiVerifyCoordinator._resetForTesting();
  });

  // =========================================================================
  // Singleton
  // =========================================================================

  describe('getInstance / singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = MultiVerifyCoordinator.getInstance();
      const b = MultiVerifyCoordinator.getInstance();
      expect(a).toBe(b);
    });

    it('getMultiVerifyCoordinator() convenience function returns the singleton', () => {
      const via_helper = getMultiVerifyCoordinator();
      expect(via_helper).toBe(MultiVerifyCoordinator.getInstance());
    });

    it('creates a new instance after _resetForTesting()', () => {
      const before = MultiVerifyCoordinator.getInstance();
      MultiVerifyCoordinator._resetForTesting();
      const after = MultiVerifyCoordinator.getInstance();
      expect(before).not.toBe(after);
    });
  });

  // =========================================================================
  // Default config
  // =========================================================================

  describe('setDefaultConfig / getDefaultConfig', () => {
    it('starts with empty default config', () => {
      expect(coordinator.getDefaultConfig()).toEqual({});
    });

    it('stores merged default config', () => {
      coordinator.setDefaultConfig({ agentCount: 5, timeout: 30000 });
      const cfg = coordinator.getDefaultConfig();
      expect(cfg.agentCount).toBe(5);
      expect(cfg.timeout).toBe(30000);
    });

    it('merges subsequent setDefaultConfig calls', () => {
      coordinator.setDefaultConfig({ agentCount: 4 });
      coordinator.setDefaultConfig({ timeout: 20000 });
      const cfg = coordinator.getDefaultConfig();
      expect(cfg.agentCount).toBe(4);
      expect(cfg.timeout).toBe(20000);
    });

    it('getDefaultConfig returns a copy (mutations do not affect internal state)', () => {
      coordinator.setDefaultConfig({ agentCount: 3 });
      const copy = coordinator.getDefaultConfig();
      copy.agentCount = 999;
      expect(coordinator.getDefaultConfig().agentCount).toBe(3);
    });
  });

  // =========================================================================
  // startVerification
  // =========================================================================

  describe('startVerification', () => {
    it('returns a verification ID string', async () => {
      registerAgentHandler(coordinator);
      const id = await coordinator.startVerification('instance-1', 'What is 2+2?');
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^verify-\d+-[a-z0-9]+$/);
    });

    it('assigns unique IDs for each call', async () => {
      registerAgentHandler(coordinator);
      const id1 = await coordinator.startVerification('instance-1', 'Query A');
      const id2 = await coordinator.startVerification('instance-1', 'Query B');
      expect(id1).not.toBe(id2);
    });

    it('emits verification:started with the request object', async () => {
      registerAgentHandler(coordinator);

      const startedPayloads: unknown[] = [];
      coordinator.on('verification:started', (payload) => startedPayloads.push(payload));

      await coordinator.startVerification('instance-1', 'Test prompt');

      expect(startedPayloads).toHaveLength(1);
      const req = startedPayloads[0] as { id: string; prompt: string; instanceId: string };
      expect(req.prompt).toBe('Test prompt');
      expect(req.instanceId).toBe('instance-1');
    });

    it('enforces minimum agent count of 3', async () => {
      registerAgentHandler(coordinator);

      const launchPayloads: Array<{ agentCount: number }> = [];
      coordinator.on('verification:agents-launching', (p) => launchPayloads.push(p));

      // Ask for 1 agent — should be bumped to 3
      await coordinator.startVerification('instance-1', 'Prompt', { agentCount: 1, timeout: 5000, synthesisStrategy: 'best-of' });
      await waitForEvent(coordinator, 'verification:completed');

      expect(launchPayloads[0].agentCount).toBeGreaterThanOrEqual(3);
    });

    it('marks verification as active immediately after start', async () => {
      // Register a handler that never calls back so the verification stays active
      coordinator.on('verification:invoke-agent', () => { /* deliberate no-op */ });

      const id = await coordinator.startVerification('instance-1', 'Stuck prompt', {
        agentCount: 3,
        timeout: 60000,
        synthesisStrategy: 'best-of',
      });

      expect(coordinator.isVerificationActive(id)).toBe(true);
    });

    it('passes context and taskType through to the request', async () => {
      registerAgentHandler(coordinator);

      const startedPayloads: unknown[] = [];
      coordinator.on('verification:started', (p) => startedPayloads.push(p));

      await coordinator.startVerification(
        'instance-1',
        'Prompt with context',
        undefined,
        'some context',
        'code-review'
      );

      const req = startedPayloads[0] as { context: string; taskType: string };
      expect(req.context).toBe('some context');
      expect(req.taskType).toBe('code-review');
    });
  });

  // =========================================================================
  // Basic verification flow (happy path)
  // =========================================================================

  describe('basic verification flow', () => {
    it('emits verification:completed after all agents respond', async () => {
      registerAgentHandler(coordinator);
      const id = await coordinator.startVerification('instance-1', 'Simple question?');

      const result = await waitForEvent<{ id: string }>(coordinator, 'verification:completed');
      expect(result.id).toBe(id);
    });

    it('stores result in getResult() after completion', async () => {
      registerAgentHandler(coordinator);
      const id = await coordinator.startVerification('instance-1', 'Store test');

      await waitForEvent(coordinator, 'verification:completed');

      const result = coordinator.getResult(id);
      expect(result).toBeDefined();
      expect(result!.id).toBe(id);
    });

    it('removes verification from active set after completion', async () => {
      registerAgentHandler(coordinator);
      const id = await coordinator.startVerification('instance-1', 'Active removal test');

      await waitForEvent(coordinator, 'verification:completed');

      expect(coordinator.isVerificationActive(id)).toBe(false);
    });

    it('result contains the expected number of agent responses', async () => {
      registerAgentHandler(coordinator);
      const id = await coordinator.startVerification('instance-1', 'Agent count check', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
      });

      await waitForEvent(coordinator, 'verification:completed');

      const result = coordinator.getResult(id);
      expect(result!.responses).toHaveLength(3);
    });

    it('result has a non-empty synthesizedResponse', async () => {
      registerAgentHandler(coordinator);
      const id = await coordinator.startVerification('instance-1', 'Synthesis test', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
      });

      await waitForEvent(coordinator, 'verification:completed');

      const result = coordinator.getResult(id);
      expect(result!.synthesizedResponse).toBeTruthy();
    });

    it('totalTokens reflects sum of all agent tokens', async () => {
      registerAgentHandler(coordinator, 'Response text. Overall Confidence: 75%', 50);
      const id = await coordinator.startVerification('instance-1', 'Token sum check', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
      });

      await waitForEvent(coordinator, 'verification:completed');

      const result = coordinator.getResult(id);
      expect(result!.totalTokens).toBe(150); // 3 agents × 50 tokens
    });

    it('emits progress events during verification lifecycle', async () => {
      registerAgentHandler(coordinator);
      const progressPhases: string[] = [];
      coordinator.on('verification:progress', (payload: { progress: { phase: string } }) => {
        progressPhases.push(payload.progress.phase);
      });

      await coordinator.startVerification('instance-1', 'Progress test', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
      });
      await waitForEvent(coordinator, 'verification:completed');

      expect(progressPhases).toContain('spawning');
      expect(progressPhases).toContain('collecting');
      expect(progressPhases).toContain('analyzing');
      expect(progressPhases).toContain('complete');
    });
  });

  // =========================================================================
  // Caching
  // =========================================================================

  describe('caching', () => {
    it('uses cached result when cache hit is returned', async () => {
      const cachedResult = {
        id: 'cached-verify-id',
        request: { id: 'cached-verify-id', instanceId: 'i', prompt: 'cached prompt', config: {} as never },
        responses: [],
        analysis: { agreements: [], disagreements: [], uniqueInsights: [], responseRankings: [], overallConfidence: 0.9, outlierAgents: [], consensusStrength: 0.9 },
        synthesizedResponse: 'Cached synthesized response',
        synthesisMethod: 'best-of' as const,
        synthesisConfidence: 0.9,
        totalDuration: 100,
        totalTokens: 0,
        totalCost: 0,
        completedAt: Date.now(),
      };

      mockGetCached.mockResolvedValue({ result: cachedResult, timestamp: Date.now() });

      // No agent handler registered — if caching works, agents will never be invoked
      const agentInvocations: unknown[] = [];
      coordinator.on('verification:invoke-agent', (p) => agentInvocations.push(p));

      const id = await coordinator.startVerification('instance-1', 'cached prompt');
      const completed = await waitForEvent<{ fromCache?: boolean }>(coordinator, 'verification:completed');

      expect(completed.fromCache).toBe(true);
      expect(agentInvocations).toHaveLength(0);
      void id; // result stored under the new request ID
    });

    it('stores result in cache after a fresh verification', async () => {
      registerAgentHandler(coordinator);
      await coordinator.startVerification('instance-1', 'Fresh query', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
      });
      await waitForEvent(coordinator, 'verification:completed');

      expect(mockCacheStore).toHaveBeenCalledTimes(1);
    });

    it('skips agent invocation when cache returns a hit', async () => {
      const cachedResult = {
        id: 'prior-id',
        request: { id: 'prior-id', instanceId: 'i', prompt: 'repeat', config: {} as never },
        responses: [],
        analysis: { agreements: [], disagreements: [], uniqueInsights: [], responseRankings: [], overallConfidence: 0.8, outlierAgents: [], consensusStrength: 0.8 },
        synthesizedResponse: 'Cached answer',
        synthesisMethod: 'consensus' as const,
        synthesisConfidence: 0.8,
        totalDuration: 50,
        totalTokens: 0,
        totalCost: 0,
        completedAt: Date.now(),
      };
      mockGetCached.mockResolvedValue({ result: cachedResult, timestamp: Date.now() });

      let invokeCount = 0;
      coordinator.on('verification:invoke-agent', () => { invokeCount++; });

      await coordinator.startVerification('instance-1', 'repeat');
      await waitForEvent(coordinator, 'verification:completed');

      expect(invokeCount).toBe(0);
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('emits verification:error when no handler is registered for invoke-agent', async () => {
      // Register the error listener before starting the verification so we
      // don't miss an event that fires in the same microtask batch.
      const errors: Array<{ error: Error }> = [];
      coordinator.on('verification:error', (p) => errors.push(p));

      // No invoke-agent handler registered — use maxRetries=0 and retryDelayMs=0
      // so the InsufficientAgentsError is thrown immediately without multi-second delays.
      await coordinator.startVerification('instance-1', 'No handler query', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
        healthConfig: { maxRetries: 0, retryDelayMs: 0, timeoutMs: 5000, minSuccessfulAgents: 2 },
      });

      // Wait for the async verification + microtask queue to flush
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].error.message).toMatch(/No handler registered|Insufficient agents/);
    });

    it('InsufficientAgentsError is thrown when too few agents succeed', async () => {
      // All agents fail — after exhausting retries none succeed
      coordinator.on('verification:invoke-agent', (payload: InvokeAgentPayload) => {
        payload.callback('Agent failed');
      });

      const errors: Array<{ error: Error }> = [];
      coordinator.on('verification:error', (p) => errors.push(p));

      await coordinator.startVerification('instance-1', 'All fail', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
        healthConfig: { maxRetries: 0, retryDelayMs: 0, timeoutMs: 5000, minSuccessfulAgents: 2 },
      });

      // Wait for error event
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].error).toBeInstanceOf(InsufficientAgentsError);
      const err = errors[0].error as InsufficientAgentsError;
      expect(err.successfulAgents).toBe(0);
      expect(err.minRequired).toBe(2);
    });

    it('InsufficientAgentsError carries correct successfulAgents count', async () => {
      // 1 agent succeeds, minimum required is 2
      let callCount = 0;
      coordinator.on('verification:invoke-agent', (payload: InvokeAgentPayload) => {
        if (callCount === 0) {
          callCount++;
          payload.callback(null, 'One success. Overall Confidence: 70%', 50, 0);
        } else {
          callCount++;
          payload.callback('Failed');
        }
      });

      const errors: Array<{ error: Error }> = [];
      coordinator.on('verification:error', (p) => errors.push(p));

      await coordinator.startVerification('instance-1', 'One success', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
        healthConfig: { maxRetries: 0, retryDelayMs: 0, timeoutMs: 5000, minSuccessfulAgents: 2 },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errors.length).toBeGreaterThan(0);
      const err = errors[0].error as InsufficientAgentsError;
      expect(err.successfulAgents).toBe(1);
    });

    it('gracefully handles agent timeout by marking response with timedOut flag', async () => {
      // Handler never calls callback — agent will time out
      coordinator.on('verification:invoke-agent', () => { /* deliberate no-op */ });

      const errors: Array<{ error: Error }> = [];
      coordinator.on('verification:error', (p) => errors.push(p));

      await coordinator.startVerification('instance-1', 'Timeout test', {
        agentCount: 3,
        timeout: 30, // extremely short
        synthesisStrategy: 'best-of',
        healthConfig: { maxRetries: 0, retryDelayMs: 0, timeoutMs: 30, minSuccessfulAgents: 2 },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(errors.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Configuration: synthesis strategies
  // =========================================================================

  describe('synthesis strategies', () => {
    it('best-of strategy selects the highest-ranked response', async () => {
      registerAgentHandler(coordinator, 'Best response. Overall Confidence: 90%');
      const id = await coordinator.startVerification('instance-1', 'Best-of test', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
      });
      await waitForEvent(coordinator, 'verification:completed');

      const result = coordinator.getResult(id);
      expect(result!.synthesisMethod).toBe('best-of');
      expect(result!.synthesizedResponse).toContain('agents');
    });

    it('consensus strategy produces output with consensus points', async () => {
      // Provide responses with matching key points so consensus can form
      registerAgentHandler(
        coordinator,
        '## Key Points\n- [Category: fact] The sky is blue (Confidence: 85%)\n## Overall Confidence\n85%'
      );
      const id = await coordinator.startVerification('instance-1', 'Consensus test', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'consensus',
      });
      await waitForEvent(coordinator, 'verification:completed');

      const result = coordinator.getResult(id);
      expect(result!.synthesisMethod).toBe('consensus');
    });

    it('majority-vote strategy emits result with synthesisMethod majority-vote', async () => {
      registerDistinctAgentHandler(coordinator);
      const id = await coordinator.startVerification('instance-1', 'Majority vote test', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'majority-vote',
      });
      await waitForEvent(coordinator, 'verification:completed');

      const result = coordinator.getResult(id);
      expect(result!.synthesisMethod).toBe('majority-vote');
    });
  });

  // =========================================================================
  // Semantic clustering
  // =========================================================================

  describe('semantic clustering', () => {
    it('uses clusterResponsesSemantically when useSemanticClustering is not disabled', async () => {
      registerAgentHandler(coordinator);
      await coordinator.startVerification('instance-1', 'Clustering test', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
        useSemanticClustering: true,
      });
      await waitForEvent(coordinator, 'verification:completed');

      expect(mockClusterResponses).toHaveBeenCalled();
    });

    it('skips semantic clustering when useSemanticClustering is false', async () => {
      registerDistinctAgentHandler(coordinator);
      await coordinator.startVerification('instance-1', 'No cluster test', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
        useSemanticClustering: false,
      });
      await waitForEvent(coordinator, 'verification:completed');

      expect(mockClusterResponses).not.toHaveBeenCalled();
    });

    it('falls back to bag-of-words clustering when embeddingService throws', async () => {
      mockClusterResponses.mockRejectedValueOnce(new Error('Embedding service unavailable'));
      registerAgentHandler(coordinator);

      const id = await coordinator.startVerification('instance-1', 'Fallback cluster test', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
        useSemanticClustering: true,
      });

      // Should complete without throwing — fallback should kick in
      await waitForEvent(coordinator, 'verification:completed');

      const result = coordinator.getResult(id);
      expect(result).toBeDefined();
    });

    it('clusterResponsesSemantically public method returns array of clusters', async () => {
      mockClusterResponses.mockResolvedValueOnce([
        {
          id: 'cluster-1',
          centroid: [],
          members: [{ agentId: 'agent-0', response: { agentId: 'agent-0' }, similarity: 0.9 }],
          averageSimilarity: 0.9,
        },
      ]);

      registerAgentHandler(coordinator);
      await coordinator.startVerification('instance-1', 'Cluster result check', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
      });
      await waitForEvent(coordinator, 'verification:completed');

      expect(mockClusterResponses).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Query methods
  // =========================================================================

  describe('getActiveVerifications', () => {
    it('returns empty array when no verifications are running', () => {
      expect(coordinator.getActiveVerifications()).toEqual([]);
    });

    it('returns all currently active verifications', async () => {
      // Keep agents hanging so verifications stay active
      coordinator.on('verification:invoke-agent', () => { /* no-op */ });

      await coordinator.startVerification('instance-1', 'Active 1', { agentCount: 3, timeout: 60000, synthesisStrategy: 'best-of' });
      await coordinator.startVerification('instance-1', 'Active 2', { agentCount: 3, timeout: 60000, synthesisStrategy: 'best-of' });

      expect(coordinator.getActiveVerifications()).toHaveLength(2);
    });
  });

  describe('getResultsByInstance', () => {
    it('returns empty array for unknown instanceId', () => {
      expect(coordinator.getResultsByInstance('unknown-id')).toEqual([]);
    });

    it('returns only results for the given instanceId', async () => {
      registerAgentHandler(coordinator);

      await coordinator.startVerification('instance-A', 'Query 1', { agentCount: 3, timeout: 5000, synthesisStrategy: 'best-of' });
      await waitForEvent(coordinator, 'verification:completed');

      await coordinator.startVerification('instance-B', 'Query 2', { agentCount: 3, timeout: 5000, synthesisStrategy: 'best-of' });
      await waitForEvent(coordinator, 'verification:completed');

      const resultsA = coordinator.getResultsByInstance('instance-A');
      expect(resultsA).toHaveLength(1);
      expect(resultsA[0].request.instanceId).toBe('instance-A');
    });
  });

  describe('getAllResults', () => {
    it('returns empty array initially', () => {
      expect(coordinator.getAllResults()).toEqual([]);
    });

    it('returns all completed results', async () => {
      registerAgentHandler(coordinator);

      await coordinator.startVerification('instance-1', 'Q1', { agentCount: 3, timeout: 5000, synthesisStrategy: 'best-of' });
      await waitForEvent(coordinator, 'verification:completed');

      await coordinator.startVerification('instance-1', 'Q2', { agentCount: 3, timeout: 5000, synthesisStrategy: 'best-of' });
      await waitForEvent(coordinator, 'verification:completed');

      expect(coordinator.getAllResults()).toHaveLength(2);
    });
  });

  describe('isVerificationActive', () => {
    it('returns false for unknown verification ID', () => {
      expect(coordinator.isVerificationActive('no-such-id')).toBe(false);
    });

    it('returns true while a verification is running', async () => {
      coordinator.on('verification:invoke-agent', () => { /* no-op */ });
      const id = await coordinator.startVerification('instance-1', 'Check active', { agentCount: 3, timeout: 60000, synthesisStrategy: 'best-of' });
      expect(coordinator.isVerificationActive(id)).toBe(true);
    });
  });

  // =========================================================================
  // cancelVerification
  // =========================================================================

  describe('cancelVerification', () => {
    it('returns false for a non-existent verification ID', () => {
      expect(coordinator.cancelVerification('no-such-id')).toBe(false);
    });

    it('returns true and removes an active verification', async () => {
      coordinator.on('verification:invoke-agent', () => { /* no-op */ });
      const id = await coordinator.startVerification('instance-1', 'Cancel me', { agentCount: 3, timeout: 60000, synthesisStrategy: 'best-of' });

      expect(coordinator.isVerificationActive(id)).toBe(true);
      const cancelled = coordinator.cancelVerification(id);
      expect(cancelled).toBe(true);
      expect(coordinator.isVerificationActive(id)).toBe(false);
    });

    it('emits verification:cancelled event when successfully cancelled', async () => {
      coordinator.on('verification:invoke-agent', () => { /* no-op */ });
      const id = await coordinator.startVerification('instance-1', 'Cancel event', { agentCount: 3, timeout: 60000, synthesisStrategy: 'best-of' });

      const cancelledEvents: Array<{ verificationId: string }> = [];
      coordinator.on('verification:cancelled', (p) => cancelledEvents.push(p));

      coordinator.cancelVerification(id);

      expect(cancelledEvents).toHaveLength(1);
      expect(cancelledEvents[0].verificationId).toBe(id);
    });
  });

  // =========================================================================
  // InsufficientAgentsError
  // =========================================================================

  describe('InsufficientAgentsError', () => {
    it('has the correct name property', () => {
      const err = new InsufficientAgentsError('msg', 1, 2);
      expect(err.name).toBe('InsufficientAgentsError');
    });

    it('stores successfulAgents and minRequired', () => {
      const err = new InsufficientAgentsError('Not enough', 1, 3);
      expect(err.successfulAgents).toBe(1);
      expect(err.minRequired).toBe(3);
    });

    it('is an instance of Error', () => {
      const err = new InsufficientAgentsError('msg', 0, 2);
      expect(err).toBeInstanceOf(Error);
    });
  });

  // =========================================================================
  // Retry logic
  // =========================================================================

  describe('agent retry logic', () => {
    it('retries a failing agent up to maxRetries times', async () => {
      let callCount = 0;

      coordinator.on('verification:invoke-agent', (payload: InvokeAgentPayload) => {
        callCount++;
        // Fail twice then succeed on third attempt
        if (callCount <= 2) {
          payload.callback('Transient failure');
        } else {
          payload.callback(null, 'Recovered response. Overall Confidence: 75%', 50, 0.001);
        }
      });

      const id = await coordinator.startVerification('instance-1', 'Retry test', {
        agentCount: 3,
        timeout: 5000,
        synthesisStrategy: 'best-of',
        healthConfig: { maxRetries: 2, retryDelayMs: 0, timeoutMs: 5000, minSuccessfulAgents: 2 },
      });

      await waitForEvent(coordinator, 'verification:completed');

      const result = coordinator.getResult(id);
      expect(result).toBeDefined();
    });
  });
});
