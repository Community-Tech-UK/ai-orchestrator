/**
 * Metrics Collector Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MetricsCollector,
  getMetricsCollector,
} from './metrics-collector';

// Mock RLM database
vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({
    getPatterns: () => [],
    upsertPattern: vi.fn(),
  }),
}));

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    MetricsCollector.resetInstance();
    collector = getMetricsCollector({ persistMetrics: false });
  });

  afterEach(() => {
    MetricsCollector.resetInstance();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = getMetricsCollector();
      const instance2 = getMetricsCollector();
      expect(instance1).toBe(instance2);
    });

    it('should reset instance correctly', () => {
      const instance1 = getMetricsCollector();
      MetricsCollector.resetInstance();
      const instance2 = getMetricsCollector();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('Configuration', () => {
    it('should use default configuration', () => {
      const config = collector.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.maxStoredSessions).toBe(10000);
      expect(config.retentionDays).toBe(90);
    });

    it('should allow configuration updates', () => {
      collector.configure({ maxStoredSessions: 5000 });
      const config = collector.getConfig();
      expect(config.maxStoredSessions).toBe(5000);
    });
  });

  describe('Session Tracking', () => {
    it('should start and track a session', () => {
      collector.startSession('test-session-1');
      const current = collector.getCurrentSession();

      expect(current).not.toBeNull();
      expect(current?.sessionId).toBe('test-session-1');
      expect(current?.tokensUsed).toBe(0);
      expect(current?.taskCompleted).toBe(false);
    });

    it('should record context usage', () => {
      collector.startSession('test-session-2');
      collector.recordContextUsage(15000, 75);

      const current = collector.getCurrentSession();
      expect(current?.tokensUsed).toBe(15000);
      expect(current?.contextUtilizationPercent).toBe(75);
    });

    it('should record compaction events', () => {
      collector.startSession('test-session-3');
      collector.recordCompaction('SECTION');

      const current = collector.getCurrentSession();
      expect(current?.compactionTriggered).toBe(true);
      expect(current?.compactionTier).toBe('SECTION');
    });

    it('should record memory retrieval metrics', () => {
      collector.startSession('test-session-4');
      collector.recordRetrieval(10, 5, 150, true);

      const current = collector.getCurrentSession();
      expect(current?.memoriesRetrieved).toBe(10);
      expect(current?.memoriesSelected).toBe(5);
      expect(current?.retrievalLatencyMs).toBeGreaterThan(0);
      expect(current?.cacheHitRate).toBeGreaterThan(0);
    });

    it('should record Memory-R1 decisions', () => {
      collector.startSession('test-session-5');
      collector.recordMemoryR1Decision('add');
      collector.recordMemoryR1Decision('add');
      collector.recordMemoryR1Decision('noop');

      const current = collector.getCurrentSession();
      expect(current?.memoryR1Decisions?.add).toBe(2);
      expect(current?.memoryR1Decisions?.noop).toBe(1);
    });

    it('should record trajectory and pattern matches', () => {
      collector.startSession('test-session-6');
      collector.recordTrajectoryMatch();
      collector.recordTrajectoryMatch();
      collector.recordPatternMatch();

      const current = collector.getCurrentSession();
      expect(current?.trajectoryMatches).toBe(2);
      expect(current?.patternMatches).toBe(1);
    });

    it('should record user corrections', () => {
      collector.startSession('test-session-7');
      collector.recordUserCorrection();
      collector.recordUserCorrection();

      const current = collector.getCurrentSession();
      expect(current?.userCorrections).toBe(2);
    });

    it('should end session with outcome', () => {
      collector.startSession('test-session-8');
      collector.recordContextUsage(10000, 50);
      collector.recordRetrieval(5, 3, 100, false);

      const session = collector.endSession(true, 0.9);

      expect(session).not.toBeNull();
      expect(session?.sessionId).toBe('test-session-8');
      expect(session?.taskCompleted).toBe(true);
      expect(session?.taskScore).toBe(0.9);
      expect(collector.getCurrentSession()).toBeNull();
    });

    it('should record prompt cache metrics', () => {
      collector.startSession('test-session-9');
      collector.recordPromptCache(1000, 5000, 2.5);

      const current = collector.getCurrentSession();
      expect(current?.cacheCreationTokens).toBe(1000);
      expect(current?.cacheReadTokens).toBe(5000);
      expect(current?.estimatedCostSavings).toBe(2.5);
    });
  });

  describe('Report Generation', () => {
    beforeEach(() => {
      // Create some test sessions
      for (let i = 0; i < 10; i++) {
        collector.startSession(`report-session-${i}`);
        collector.recordContextUsage(10000 + i * 1000, 50 + i);
        collector.recordRetrieval(10, 5, 100 + i * 10, i % 2 === 0);
        collector.recordMemoryR1Decision(i % 2 === 0 ? 'add' : 'noop');
        if (i % 3 === 0) {
          collector.recordCompaction('SECTION');
        }
        collector.endSession(i % 4 !== 0, 0.8);
      }
    });

    it('should generate report for date range', () => {
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

      const report = collector.generateReport(startDate, endDate);

      expect(report.sessionCount).toBe(10);
      expect(report.avgTokensPerSession).toBeGreaterThan(0);
      expect(report.taskCompletionRate).toBeGreaterThan(0);
      expect(report.compactionRate).toBeGreaterThan(0);
    });

    it('should calculate memory utilization', () => {
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

      const report = collector.generateReport(startDate, endDate);

      expect(report.memoryUtilization.avgMemoriesRetrieved).toBe(10);
      expect(report.memoryUtilization.avgMemoriesSelected).toBe(5);
      expect(report.memoryUtilization.selectionEfficiency).toBe(0.5);
    });

    it('should calculate compaction tier distribution', () => {
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

      const report = collector.generateReport(startDate, endDate);

      expect(report.compactionTierDistribution).toBeDefined();
      expect(report.compactionTierDistribution.SECTION).toBeGreaterThan(0);
      expect(report.compactionTierDistribution.none).toBeGreaterThan(0);
    });

    it('should calculate decision distribution', () => {
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

      const report = collector.generateReport(startDate, endDate);

      expect(report.decisionDistribution.add).toBeGreaterThan(0);
      expect(report.decisionDistribution.noop).toBeGreaterThan(0);
    });

    it('should return empty report for no sessions', () => {
      MetricsCollector.resetInstance();
      collector = getMetricsCollector({ persistMetrics: false });

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

      const report = collector.generateReport(startDate, endDate);

      expect(report.sessionCount).toBe(0);
      expect(report.avgTokensPerSession).toBe(0);
    });
  });

  describe('Baseline Management', () => {
    beforeEach(() => {
      // Create test sessions for baseline
      for (let i = 0; i < 5; i++) {
        collector.startSession(`baseline-session-${i}`);
        collector.recordContextUsage(15000, 60);
        collector.recordRetrieval(8, 4, 120, true);
        collector.endSession(true, 0.85);
      }
    });

    it('should create baseline snapshot', () => {
      const baseline = collector.createBaseline('Test Baseline v1', {
        description: 'Initial baseline for testing',
        days: 7,
      });

      expect(baseline).not.toBeNull();
      expect(baseline?.name).toBe('Test Baseline v1');
      expect(baseline?.sessionCount).toBe(5);
      expect(baseline?.taskCompletionRate).toBe(1); // All sessions completed
    });

    it('should retrieve baseline by ID', () => {
      const created = collector.createBaseline('Baseline A');
      expect(created).not.toBeNull();

      const retrieved = collector.getBaseline(created!.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.name).toBe('Baseline A');
    });

    it('should list all baselines', () => {
      collector.createBaseline('Baseline 1');
      collector.createBaseline('Baseline 2');

      const baselines = collector.listBaselines();
      expect(baselines.length).toBe(2);
    });

    it('should delete baseline', () => {
      const baseline = collector.createBaseline('To Delete');
      expect(baseline).not.toBeNull();

      const deleted = collector.deleteBaseline(baseline!.id);
      expect(deleted).toBe(true);

      const retrieved = collector.getBaseline(baseline!.id);
      expect(retrieved).toBeNull();
    });

    it('should return null for baseline with no sessions', () => {
      MetricsCollector.resetInstance();
      collector = getMetricsCollector({ persistMetrics: false });

      const baseline = collector.createBaseline('Empty Baseline');
      expect(baseline).toBeNull();
    });
  });

  describe('Baseline Comparison', () => {
    let baselineId: string;

    beforeEach(() => {
      // Create baseline sessions (lower performance)
      for (let i = 0; i < 5; i++) {
        collector.startSession(`old-session-${i}`);
        collector.recordContextUsage(20000, 80); // Higher token usage
        collector.recordRetrieval(10, 3, 200, false); // Slower, no cache
        collector.endSession(i % 2 === 0, 0.6); // 60% completion
      }

      const baseline = collector.createBaseline('Old Baseline');
      baselineId = baseline!.id;

      // Create new sessions (better performance)
      for (let i = 0; i < 5; i++) {
        collector.startSession(`new-session-${i}`);
        collector.recordContextUsage(15000, 60); // Lower token usage
        collector.recordRetrieval(10, 5, 100, true); // Faster, with cache
        collector.endSession(true, 0.9); // 100% completion
      }
    });

    it('should compare to baseline', () => {
      const comparison = collector.compareToBaseline(baselineId, 7);

      expect(comparison).not.toBeNull();
      expect(comparison?.baselineName).toBe('Old Baseline');
    });

    it('should show improvement in metrics', () => {
      const comparison = collector.compareToBaseline(baselineId, 7);

      expect(comparison).not.toBeNull();
      // Task completion should show improvement (100% vs 60%)
      expect(comparison!.taskCompletionImprovement).toBeGreaterThan(0);
      // Latency should show reduction (100ms vs 200ms)
      expect(comparison!.latencyReduction).toBeGreaterThan(0);
    });

    it('should return null for invalid baseline', () => {
      const comparison = collector.compareToBaseline('invalid-id', 7);
      expect(comparison).toBeNull();
    });
  });

  describe('Statistics & Queries', () => {
    beforeEach(() => {
      for (let i = 0; i < 10; i++) {
        collector.startSession(`stats-session-${i}`);
        collector.recordContextUsage(10000 + i * 500, 50);
        collector.endSession(true, 0.8);
      }
    });

    it('should get recent sessions', () => {
      const recent = collector.getRecentSessions(5);
      expect(recent.length).toBe(5);
    });

    it('should get sessions by date range', () => {
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 1 * 24 * 60 * 60 * 1000);

      const sessions = collector.getSessionsByDateRange(startDate, endDate);
      expect(sessions.length).toBe(10);
    });

    it('should get aggregate statistics', () => {
      const stats = collector.getStats();

      expect(stats.totalSessions).toBe(10);
      expect(stats.oldestSession).not.toBeNull();
      expect(stats.newestSession).not.toBeNull();
      expect(stats.currentConfig).toBeDefined();
    });
  });

  describe('Session Pruning', () => {
    it('should prune sessions exceeding max count', () => {
      // Configure low max
      collector.configure({ maxStoredSessions: 5 });

      // Create 10 sessions
      for (let i = 0; i < 10; i++) {
        collector.startSession(`prune-session-${i}`);
        collector.endSession(true, 0.8);
      }

      const recent = collector.getRecentSessions(100);
      expect(recent.length).toBe(5);
    });
  });

  describe('Event Emission', () => {
    it('should emit session:recorded event', () => {
      const handler = vi.fn();
      collector.on('session:recorded', handler);

      collector.startSession('event-session');
      collector.endSession(true, 1.0);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'event-session' })
      );
    });

    it('should emit baseline:created event', () => {
      // Create sessions first
      for (let i = 0; i < 3; i++) {
        collector.startSession(`event-baseline-${i}`);
        collector.endSession(true, 0.8);
      }

      const handler = vi.fn();
      collector.on('baseline:created', handler);

      collector.createBaseline('Event Baseline');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit report:generated event', () => {
      // Create a session
      collector.startSession('report-event');
      collector.endSession(true, 0.9);

      const handler = vi.fn();
      collector.on('report:generated', handler);

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
      collector.generateReport(startDate, endDate);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
