import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock modules before imports
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../vcs/remotes/github-pr-poller', () => ({
  fetchPREnrichmentBatch: vi.fn(),
  formatCIFailureMessage: vi.fn((checks: unknown[]) => `CI failing: ${(checks as { name: string }[]).map((c) => c.name).join(', ')}`),
  formatReviewMessage: vi.fn(() => 'Changes requested'),
}));

vi.mock('../../vcs/remotes/git-host-connector', () => ({
  parseGitHostWorkItemUrl: vi.fn((url: string) => {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;
    return { provider: 'github', owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
  }),
}));

vi.mock('../../../shared/utils/id-generator', () => ({
  generateId: () => 'test-event-id',
}));

import { ReactionEngine, _resetReactionEngineForTesting } from '../reaction-engine';
import { fetchPREnrichmentBatch } from '../../vcs/remotes/github-pr-poller';
import type { PREnrichmentData, ReactionEvent } from '../../../shared/types/reaction.types';
import type { InstanceManager } from '../../instance/instance-manager';

type EventHandler = (...args: unknown[]) => void;

function createMockInstanceManager() {
  const instances = new Map<string, { id: string; status: string }>();
  const events = new Map<string, EventHandler[]>();

  return {
    getInstance: vi.fn((id: string) => instances.get(id) ?? { id, status: 'busy' }),
    sendInput: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: EventHandler) => {
      if (!events.has(event)) events.set(event, []);
      events.get(event)!.push(handler);
    }),
    _emit: (event: string, ...args: unknown[]) => {
      for (const handler of events.get(event) ?? []) handler(...args);
    },
    _setInstance: (id: string, data: { id: string; status: string }) => instances.set(id, data),
  };
}

function makePRData(overrides?: Partial<PREnrichmentData>): PREnrichmentData {
  return {
    owner: 'test-org',
    repo: 'test-repo',
    number: 42,
    url: 'https://github.com/test-org/test-repo/pull/42',
    state: 'open',
    ciStatus: 'passing',
    ciChecks: [],
    reviewDecision: 'none',
    mergeable: true,
    hasConflicts: false,
    headBranch: 'feat/test',
    baseBranch: 'main',
    fetchedAt: Date.now(),
    ...overrides,
  };
}

describe('ReactionEngine', () => {
  let engine: ReactionEngine;
  let mockInstanceManager: ReturnType<typeof createMockInstanceManager>;

  beforeEach(() => {
    _resetReactionEngineForTesting();
    vi.clearAllMocks();
    vi.useFakeTimers();

    engine = ReactionEngine.getInstance();
    mockInstanceManager = createMockInstanceManager();

    engine.initialize(mockInstanceManager as unknown as InstanceManager, {
      enabled: true,
      pollIntervalMs: 5000,
    });
  });

  afterEach(() => {
    engine.stop();
    vi.useRealTimers();
  });

  describe('singleton pattern', () => {
    it('returns the same instance', () => {
      expect(ReactionEngine.getInstance()).toBe(engine);
    });

    it('resets for testing', () => {
      _resetReactionEngineForTesting();
      expect(ReactionEngine.getInstance()).not.toBe(engine);
    });
  });

  describe('instance tracking', () => {
    it('tracks an instance with a PR URL', () => {
      engine.trackInstance('inst-1', 'https://github.com/test-org/test-repo/pull/42');

      const state = engine.getTrackingState('inst-1');
      expect(state).toBeDefined();
      expect(state?.prUrl).toBe('https://github.com/test-org/test-repo/pull/42');
      expect(state?.instanceId).toBe('inst-1');
    });

    it('untracks an instance', () => {
      engine.trackInstance('inst-1', 'https://github.com/test-org/test-repo/pull/42');
      engine.untrackInstance('inst-1');

      expect(engine.getTrackingState('inst-1')).toBeUndefined();
    });

    it('cleans up when instance is removed', () => {
      engine.trackInstance('inst-1', 'https://github.com/test-org/test-repo/pull/42');
      mockInstanceManager._emit('instance:removed', 'inst-1');

      expect(engine.getTrackingState('inst-1')).toBeUndefined();
    });

    it('returns all tracked instances', () => {
      engine.trackInstance('inst-1', 'https://github.com/test-org/test-repo/pull/42');
      engine.trackInstance('inst-2', 'https://github.com/test-org/test-repo/pull/43');

      expect(engine.getTrackedInstances()).toHaveLength(2);
    });
  });

  describe('polling', () => {
    it('auto-starts when an instance is tracked', () => {
      expect(engine.isRunning()).toBe(false);
      engine.trackInstance('inst-1', 'https://github.com/test-org/test-repo/pull/42');
      expect(engine.isRunning()).toBe(true);
    });

    it('auto-stops when no instances are tracked', () => {
      engine.trackInstance('inst-1', 'https://github.com/test-org/test-repo/pull/42');
      expect(engine.isRunning()).toBe(true);

      engine.untrackInstance('inst-1');
      expect(engine.isRunning()).toBe(false);
    });
  });

  describe('CI state transitions', () => {
    it('sends feedback to agent when CI fails', async () => {
      const enrichmentMap = new Map<string, PREnrichmentData>();
      // First poll: CI passing (baseline)
      enrichmentMap.set('test-org/test-repo#42', makePRData({ ciStatus: 'passing' }));
      vi.mocked(fetchPREnrichmentBatch).mockResolvedValueOnce(enrichmentMap);

      engine.trackInstance('inst-1', 'https://github.com/test-org/test-repo/pull/42');
      await vi.advanceTimersByTimeAsync(100); // First poll

      // Second poll: CI failing
      const failingData = makePRData({
        ciStatus: 'failing',
        ciChecks: [{ name: 'tests', status: 'failing', conclusion: 'failure' }],
      });
      enrichmentMap.set('test-org/test-repo#42', failingData);
      vi.mocked(fetchPREnrichmentBatch).mockResolvedValueOnce(enrichmentMap);

      await vi.advanceTimersByTimeAsync(5000); // Second poll

      expect(mockInstanceManager.sendInput).toHaveBeenCalledWith(
        'inst-1',
        expect.stringContaining('CI failing'),
      );
    });

    it('clears CI failure tracker when CI recovers', async () => {
      const enrichmentMap = new Map<string, PREnrichmentData>();
      // Baseline
      enrichmentMap.set('test-org/test-repo#42', makePRData({ ciStatus: 'passing' }));
      vi.mocked(fetchPREnrichmentBatch).mockResolvedValueOnce(enrichmentMap);

      engine.trackInstance('inst-1', 'https://github.com/test-org/test-repo/pull/42');
      await vi.advanceTimersByTimeAsync(100);

      // CI fails
      enrichmentMap.set('test-org/test-repo#42', makePRData({ ciStatus: 'failing', ciChecks: [{ name: 'tests', status: 'failing' }] }));
      vi.mocked(fetchPREnrichmentBatch).mockResolvedValueOnce(enrichmentMap);
      await vi.advanceTimersByTimeAsync(5000);

      // CI recovers
      enrichmentMap.set('test-org/test-repo#42', makePRData({ ciStatus: 'passing' }));
      vi.mocked(fetchPREnrichmentBatch).mockResolvedValueOnce(enrichmentMap);

      const events: ReactionEvent[] = [];
      engine.on('reaction:event', (e: ReactionEvent) => events.push(e));
      await vi.advanceTimersByTimeAsync(5000);

      const passingEvent = events.find((e) => e.type === 'ci.passing');
      expect(passingEvent).toBeDefined();
    });
  });

  describe('review transitions', () => {
    it('sends feedback when changes are requested', async () => {
      const enrichmentMap = new Map<string, PREnrichmentData>();
      // Baseline
      enrichmentMap.set('test-org/test-repo#42', makePRData({ reviewDecision: 'none' }));
      vi.mocked(fetchPREnrichmentBatch).mockResolvedValueOnce(enrichmentMap);

      engine.trackInstance('inst-1', 'https://github.com/test-org/test-repo/pull/42');
      await vi.advanceTimersByTimeAsync(100);

      // Changes requested
      enrichmentMap.set('test-org/test-repo#42', makePRData({ reviewDecision: 'changes_requested' }));
      vi.mocked(fetchPREnrichmentBatch).mockResolvedValueOnce(enrichmentMap);
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockInstanceManager.sendInput).toHaveBeenCalledWith(
        'inst-1',
        expect.stringContaining('Changes requested'),
      );
    });
  });

  describe('escalation', () => {
    it('escalates after max retries via repeated CI fail/recover cycles', async () => {
      const enrichmentMap = new Map<string, PREnrichmentData>();
      // Baseline: passing
      enrichmentMap.set('test-org/test-repo#42', makePRData({ ciStatus: 'passing' }));
      vi.mocked(fetchPREnrichmentBatch).mockResolvedValueOnce(enrichmentMap);

      engine.trackInstance('inst-1', 'https://github.com/test-org/test-repo/pull/42');
      await vi.advanceTimersByTimeAsync(100); // First poll (baseline)

      const escalatedEvents: unknown[] = [];
      engine.on('reaction:escalated', (e: unknown) => escalatedEvents.push(e));

      // Cycle CI fail → pass → fail to trigger multiple transitions
      // Default retries: 2, so the 3rd failure triggers escalation
      for (let i = 0; i < 4; i++) {
        // CI fails
        enrichmentMap.set('test-org/test-repo#42', makePRData({
          ciStatus: 'failing',
          ciChecks: [{ name: 'tests', status: 'failing' }],
        }));
        vi.mocked(fetchPREnrichmentBatch).mockResolvedValueOnce(new Map(enrichmentMap));
        await vi.advanceTimersByTimeAsync(5000);

        // CI recovers (so next failure is a new transition)
        enrichmentMap.set('test-org/test-repo#42', makePRData({ ciStatus: 'passing' }));
        vi.mocked(fetchPREnrichmentBatch).mockResolvedValueOnce(new Map(enrichmentMap));
        await vi.advanceTimersByTimeAsync(5000);
      }

      // After 4 fail/recover cycles, the ci-failed tracker has 4 attempts (> retries: 2)
      expect(escalatedEvents.length).toBeGreaterThan(0);
    });
  });

  describe('configuration', () => {
    it('updates configuration dynamically', () => {
      engine.updateConfig({ pollIntervalMs: 10000 });
      expect(engine.getConfig().pollIntervalMs).toBe(10000);
    });

    it('disables engine via config update', () => {
      engine.trackInstance('inst-1', 'https://github.com/test-org/test-repo/pull/42');
      expect(engine.isRunning()).toBe(true);

      engine.updateConfig({ enabled: false });
      expect(engine.isRunning()).toBe(false);
    });
  });
});
