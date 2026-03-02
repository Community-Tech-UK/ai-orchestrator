/**
 * Metrics Collector
 * Baseline metrics collection for Memory Enhancement Plan (Phase 0)
 *
 * Aggregates metrics from:
 * - UnifiedMemoryController (retrieval, caching)
 * - Memory-R1 (decisions, learning)
 * - Smart Compaction (context management)
 * - Training Loop (learning progress)
 * - OutcomeTracker (task outcomes)
 *
 * Provides:
 * - Session-level metrics recording
 * - Baseline snapshot creation
 * - Before/after comparison reports
 */

import { EventEmitter } from 'events';
import { getRLMDatabase, RLMDatabase } from '../persistence/rlm-database';
import { getLogger } from '../logging/logger';
import type {
  SessionMetrics,
  MetricsReport,
  BaselineSnapshot,
  BaselineComparison,
  MetricsCollectorConfig,
  MemoryR1DecisionCounts,
  CompactionTier,
  DailyTrend,
  MemoryUtilizationMetrics,
} from '../../shared/types/metrics.types';

// ============================================
// Default Configuration
// ============================================

const logger = getLogger('MetricsCollector');

const DEFAULT_CONFIG: MetricsCollectorConfig = {
  enabled: true,
  persistMetrics: true,
  maxStoredSessions: 10000,
  retentionDays: 90,
};

// ============================================
// Metrics Collector
// ============================================

export class MetricsCollector extends EventEmitter {
  private static instance: MetricsCollector;
  private config: MetricsCollectorConfig;
  private sessions: SessionMetrics[] = [];
  private baselines: Map<string, BaselineSnapshot> = new Map();
  private db: RLMDatabase | null = null;

  // Current session tracking
  private currentSession: Partial<SessionMetrics> | null = null;

  private constructor(config: Partial<MetricsCollectorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializePersistence();
  }

  static getInstance(config?: Partial<MetricsCollectorConfig>): MetricsCollector {
    if (!this.instance) {
      this.instance = new MetricsCollector(config);
    }
    return this.instance;
  }

  static resetInstance(): void {
    this.instance = undefined as unknown as MetricsCollector;
  }

  // ============================================
  // Configuration
  // ============================================

  configure(config: Partial<MetricsCollectorConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('config:updated', this.config);
  }

  getConfig(): MetricsCollectorConfig {
    return { ...this.config };
  }

  // ============================================
  // Persistence
  // ============================================

  private initializePersistence(): void {
    if (!this.config.persistMetrics) return;

    try {
      this.db = getRLMDatabase();
      this.loadFromPersistence();
    } catch (error) {
      logger.error('Failed to initialize persistence', error instanceof Error ? error : undefined);
    }
  }

  private loadFromPersistence(): void {
    if (!this.db) return;

    try {
      // Load sessions from patterns table with type='metrics_session'
      const patterns = this.db.getPatterns('metrics_session');
      for (const pattern of patterns) {
        try {
          const session = JSON.parse(pattern.metadata_json || '{}') as SessionMetrics;
          if (session.sessionId) {
            this.sessions.push(session);
          }
        } catch {
          // Skip malformed entries
        }
      }

      // Load baselines from patterns table with type='metrics_baseline'
      const baselinePatterns = this.db.getPatterns('metrics_baseline');
      for (const pattern of baselinePatterns) {
        try {
          const baseline = JSON.parse(pattern.metadata_json || '{}') as BaselineSnapshot;
          if (baseline.id) {
            this.baselines.set(baseline.id, baseline);
          }
        } catch {
          // Skip malformed entries
        }
      }

      // Sort sessions by timestamp
      this.sessions.sort((a, b) => a.timestamp - b.timestamp);

      this.emit('persistence:loaded', {
        sessions: this.sessions.length,
        baselines: this.baselines.size,
      });
    } catch (error) {
      logger.error('Failed to load from persistence', error instanceof Error ? error : undefined);
    }
  }

  private persistSession(session: SessionMetrics): void {
    if (!this.db || !this.config.persistMetrics) return;

    try {
      this.db.upsertPattern({
        id: `metrics-session-${session.sessionId}`,
        type: 'metrics_session',
        key: session.sessionId,
        effectiveness: session.taskCompleted ? 1 : 0,
        sampleSize: 1,
        metadata: session as unknown as Record<string, unknown>,
      });
    } catch (error) {
      logger.error('Failed to persist session', error instanceof Error ? error : undefined);
    }
  }

  private persistBaseline(baseline: BaselineSnapshot): void {
    if (!this.db || !this.config.persistMetrics) return;

    try {
      this.db.upsertPattern({
        id: `metrics-baseline-${baseline.id}`,
        type: 'metrics_baseline',
        key: baseline.id,
        effectiveness: baseline.taskCompletionRate,
        sampleSize: baseline.sessionCount,
        metadata: baseline as unknown as Record<string, unknown>,
      });
    } catch (error) {
      logger.error('Failed to persist baseline', error instanceof Error ? error : undefined);
    }
  }

  // ============================================
  // Session Tracking
  // ============================================

  /**
   * Start tracking a new session
   */
  startSession(sessionId: string): void {
    if (!this.config.enabled) return;

    this.currentSession = {
      sessionId,
      timestamp: Date.now(),
      tokensUsed: 0,
      contextUtilizationPercent: 0,
      compactionTriggered: false,
      compactionTier: null,
      memoriesRetrieved: 0,
      memoriesSelected: 0,
      retrievalLatencyMs: 0,
      cacheHitRate: 0,
      memoryR1Decisions: { add: 0, update: 0, delete: 0, noop: 0 },
      trajectoryMatches: 0,
      patternMatches: 0,
      taskCompleted: false,
      taskScore: 0,
      userCorrections: 0,
      qualityCostProfile: 'balanced',
      trainingStage: 1,
    };

    this.emit('session:started', { sessionId });
  }

  /**
   * Record context usage
   */
  recordContextUsage(tokensUsed: number, utilizationPercent: number): void {
    if (!this.currentSession) return;

    this.currentSession.tokensUsed = tokensUsed;
    this.currentSession.contextUtilizationPercent = utilizationPercent;
  }

  /**
   * Record compaction event
   */
  recordCompaction(tier: CompactionTier): void {
    if (!this.currentSession) return;

    this.currentSession.compactionTriggered = true;
    this.currentSession.compactionTier = tier;
  }

  /**
   * Record memory retrieval metrics
   */
  recordRetrieval(retrieved: number, selected: number, latencyMs: number, cacheHit: boolean): void {
    if (!this.currentSession) return;

    this.currentSession.memoriesRetrieved = (this.currentSession.memoriesRetrieved || 0) + retrieved;
    this.currentSession.memoriesSelected = (this.currentSession.memoriesSelected || 0) + selected;

    // Rolling average for latency
    const prevLatency = this.currentSession.retrievalLatencyMs || 0;
    const count = retrieved > 0 ? 1 : 0;
    this.currentSession.retrievalLatencyMs = count > 0 ? (prevLatency + latencyMs) / 2 : prevLatency;

    // Track cache hit rate
    const prevHits = (this.currentSession.cacheHitRate || 0) * (retrieved - 1);
    const newHits = prevHits + (cacheHit ? 1 : 0);
    this.currentSession.cacheHitRate = retrieved > 0 ? newHits / retrieved : 0;
  }

  /**
   * Record Memory-R1 decision
   */
  recordMemoryR1Decision(operation: 'add' | 'update' | 'delete' | 'noop'): void {
    if (!this.currentSession) return;

    const decisions = this.currentSession.memoryR1Decisions || { add: 0, update: 0, delete: 0, noop: 0 };
    decisions[operation]++;
    this.currentSession.memoryR1Decisions = decisions;
  }

  /**
   * Record trajectory match
   */
  recordTrajectoryMatch(): void {
    if (!this.currentSession) return;
    this.currentSession.trajectoryMatches = (this.currentSession.trajectoryMatches || 0) + 1;
  }

  /**
   * Record pattern match
   */
  recordPatternMatch(): void {
    if (!this.currentSession) return;
    this.currentSession.patternMatches = (this.currentSession.patternMatches || 0) + 1;
  }

  /**
   * Record user correction
   */
  recordUserCorrection(): void {
    if (!this.currentSession) return;
    this.currentSession.userCorrections = (this.currentSession.userCorrections || 0) + 1;
  }

  /**
   * Record prompt caching metrics (for Phase 1)
   */
  recordPromptCache(creationTokens: number, readTokens: number, savings: number): void {
    if (!this.currentSession) return;

    this.currentSession.cacheCreationTokens = creationTokens;
    this.currentSession.cacheReadTokens = readTokens;
    this.currentSession.estimatedCostSavings = savings;
  }

  /**
   * Set quality/cost profile for session
   */
  setQualityCostProfile(profile: 'quality' | 'balanced' | 'cost'): void {
    if (!this.currentSession) return;
    this.currentSession.qualityCostProfile = profile;
  }

  /**
   * Set training stage for session
   */
  setTrainingStage(stage: 1 | 2 | 3): void {
    if (!this.currentSession) return;
    this.currentSession.trainingStage = stage;
  }

  /**
   * End session with outcome
   */
  endSession(completed: boolean, score: number): SessionMetrics | null {
    if (!this.currentSession || !this.currentSession.sessionId) return null;

    this.currentSession.taskCompleted = completed;
    this.currentSession.taskScore = score;

    const session = this.currentSession as SessionMetrics;
    this.sessions.push(session);
    this.persistSession(session);

    // Prune old sessions if needed
    this.pruneOldSessions();

    this.emit('session:recorded', session);
    this.currentSession = null;

    return session;
  }

  /**
   * Get current session metrics (if active)
   */
  getCurrentSession(): Partial<SessionMetrics> | null {
    return this.currentSession;
  }

  // ============================================
  // Report Generation
  // ============================================

  /**
   * Generate metrics report for a date range
   */
  generateReport(startDate: Date, endDate: Date): MetricsReport {
    const startMs = startDate.getTime();
    const endMs = endDate.getTime();

    const filtered = this.sessions.filter(
      (s) => s.timestamp >= startMs && s.timestamp <= endMs
    );

    if (filtered.length === 0) {
      return this.emptyReport(startMs, endMs);
    }

    const report: MetricsReport = {
      startDate: startMs,
      endDate: endMs,
      sessionCount: filtered.length,

      // Aggregate metrics
      avgTokensPerSession: this.avg(filtered, 'tokensUsed'),
      compactionRate: this.rate(filtered, 'compactionTriggered'),
      avgRetrievalLatency: this.avg(filtered, 'retrievalLatencyMs'),
      taskCompletionRate: this.rate(filtered, 'taskCompleted'),

      // Learning effectiveness
      memoryUtilization: this.calculateMemoryUtilization(filtered),
      trajectoryLearningImpact: this.calculateTrajectoryImpact(filtered),

      // Cost impact
      totalCostSavings: this.sum(filtered, 'estimatedCostSavings'),
      avgCacheHitRate: this.avg(filtered, 'cacheHitRate'),

      // Trends
      dailyTrends: this.calculateDailyTrends(filtered),

      // Distributions
      compactionTierDistribution: this.calculateTierDistribution(filtered),
      decisionDistribution: this.calculateDecisionDistribution(filtered),
    };

    this.emit('report:generated', report);
    return report;
  }

  private emptyReport(startMs: number, endMs: number): MetricsReport {
    return {
      startDate: startMs,
      endDate: endMs,
      sessionCount: 0,
      avgTokensPerSession: 0,
      compactionRate: 0,
      avgRetrievalLatency: 0,
      taskCompletionRate: 0,
      memoryUtilization: { avgMemoriesRetrieved: 0, avgMemoriesSelected: 0, selectionEfficiency: 0 },
      trajectoryLearningImpact: 0,
      totalCostSavings: 0,
      avgCacheHitRate: 0,
      dailyTrends: [],
      compactionTierDistribution: { FULL: 0, SECTION: 0, KEY_DECISIONS: 0, MINIMAL: 0, none: 0 },
      decisionDistribution: { add: 0, update: 0, delete: 0, noop: 0 },
    };
  }

  private calculateMemoryUtilization(sessions: SessionMetrics[]): MemoryUtilizationMetrics {
    const avgRetrieved = this.avg(sessions, 'memoriesRetrieved');
    const avgSelected = this.avg(sessions, 'memoriesSelected');
    const efficiency = avgRetrieved > 0 ? avgSelected / avgRetrieved : 0;

    return {
      avgMemoriesRetrieved: avgRetrieved,
      avgMemoriesSelected: avgSelected,
      selectionEfficiency: efficiency,
    };
  }

  private calculateTrajectoryImpact(sessions: SessionMetrics[]): number {
    // Compare completion rate for sessions with vs without trajectory matches
    const withMatches = sessions.filter((s) => s.trajectoryMatches > 0);
    const withoutMatches = sessions.filter((s) => s.trajectoryMatches === 0);

    if (withMatches.length === 0 || withoutMatches.length === 0) return 0;

    const rateWith = this.rate(withMatches, 'taskCompleted');
    const rateWithout = this.rate(withoutMatches, 'taskCompleted');

    return rateWith - rateWithout;
  }

  private calculateDailyTrends(sessions: SessionMetrics[]): DailyTrend[] {
    const byDay = new Map<string, SessionMetrics[]>();

    for (const session of sessions) {
      const date = new Date(session.timestamp).toISOString().split('T')[0];
      const existing = byDay.get(date) || [];
      existing.push(session);
      byDay.set(date, existing);
    }

    return Array.from(byDay.entries())
      .map(([date, daySessions]) => ({
        date,
        sessionCount: daySessions.length,
        avgTaskCompletion: this.rate(daySessions, 'taskCompleted'),
        avgTokens: this.avg(daySessions, 'tokensUsed'),
        avgLatency: this.avg(daySessions, 'retrievalLatencyMs'),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private calculateTierDistribution(
    sessions: SessionMetrics[]
  ): Record<CompactionTier | 'none', number> {
    const dist: Record<CompactionTier | 'none', number> = {
      FULL: 0,
      SECTION: 0,
      KEY_DECISIONS: 0,
      MINIMAL: 0,
      none: 0,
    };

    for (const session of sessions) {
      if (session.compactionTier) {
        dist[session.compactionTier]++;
      } else {
        dist['none']++;
      }
    }

    return dist;
  }

  private calculateDecisionDistribution(sessions: SessionMetrics[]): MemoryR1DecisionCounts {
    const totals: MemoryR1DecisionCounts = { add: 0, update: 0, delete: 0, noop: 0 };

    for (const session of sessions) {
      if (session.memoryR1Decisions) {
        totals.add += session.memoryR1Decisions.add;
        totals.update += session.memoryR1Decisions.update;
        totals.delete += session.memoryR1Decisions.delete;
        totals.noop += session.memoryR1Decisions.noop;
      }
    }

    return totals;
  }

  // ============================================
  // Baseline Management
  // ============================================

  /**
   * Create a baseline snapshot from recent data
   */
  createBaseline(
    name: string,
    options?: { description?: string; days?: number }
  ): BaselineSnapshot | null {
    const days = options?.days ?? 7;
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

    const report = this.generateReport(startDate, endDate);

    if (report.sessionCount === 0) {
      logger.warn('No sessions found for baseline');
      return null;
    }

    const baseline: BaselineSnapshot = {
      id: `baseline-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name,
      description: options?.description,
      createdAt: Date.now(),
      sessionCount: report.sessionCount,
      avgTokensPerSession: report.avgTokensPerSession,
      taskCompletionRate: report.taskCompletionRate,
      avgRetrievalLatency: report.avgRetrievalLatency,
      compactionRate: report.compactionRate,
      avgCacheHitRate: report.avgCacheHitRate,
      fullReport: report,
    };

    this.baselines.set(baseline.id, baseline);
    this.persistBaseline(baseline);

    this.emit('baseline:created', baseline);
    return baseline;
  }

  /**
   * Get a baseline by ID
   */
  getBaseline(id: string): BaselineSnapshot | null {
    return this.baselines.get(id) || null;
  }

  /**
   * List all baselines
   */
  listBaselines(): BaselineSnapshot[] {
    return Array.from(this.baselines.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Delete a baseline
   */
  deleteBaseline(id: string): boolean {
    return this.baselines.delete(id);
  }

  /**
   * Compare current metrics against a baseline
   */
  compareToBaseline(baselineId: string, days: number = 7): BaselineComparison | null {
    const baseline = this.baselines.get(baselineId);
    if (!baseline) return null;

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

    const currentReport = this.generateReport(startDate, endDate);

    if (currentReport.sessionCount === 0) {
      return null;
    }

    // Calculate percentage changes (positive = improvement)
    const tokenReduction = this.percentChange(
      baseline.avgTokensPerSession,
      currentReport.avgTokensPerSession,
      true // lower is better
    );

    const taskCompletionImprovement = this.percentChange(
      baseline.taskCompletionRate,
      currentReport.taskCompletionRate,
      false // higher is better
    );

    const latencyReduction = this.percentChange(
      baseline.avgRetrievalLatency,
      currentReport.avgRetrievalLatency,
      true // lower is better
    );

    const compactionRateChange = this.percentChange(
      baseline.compactionRate,
      currentReport.compactionRate,
      true // lower compaction rate = better context efficiency
    );

    const cacheHitImprovement = this.percentChange(
      baseline.avgCacheHitRate,
      currentReport.avgCacheHitRate,
      false // higher is better
    );

    // Simple significance check (need enough samples)
    const minSamplesForSignificance = 30;
    const isSignificant =
      baseline.sessionCount >= minSamplesForSignificance &&
      currentReport.sessionCount >= minSamplesForSignificance;

    // Simplified confidence (based on sample sizes)
    const confidenceLevel = Math.min(
      1,
      (baseline.sessionCount + currentReport.sessionCount) / (minSamplesForSignificance * 4)
    );

    return {
      baselineId,
      baselineName: baseline.name,
      comparisonPeriod: { start: startDate.getTime(), end: endDate.getTime() },
      tokenReduction,
      taskCompletionImprovement,
      latencyReduction,
      compactionRateChange,
      cacheHitImprovement,
      isSignificant,
      confidenceLevel,
    };
  }

  // ============================================
  // Statistics & Queries
  // ============================================

  /**
   * Get recent sessions
   */
  getRecentSessions(limit: number = 50): SessionMetrics[] {
    return this.sessions.slice(-limit);
  }

  /**
   * Get sessions by date range
   */
  getSessionsByDateRange(startDate: Date, endDate: Date): SessionMetrics[] {
    const startMs = startDate.getTime();
    const endMs = endDate.getTime();

    return this.sessions.filter(
      (s) => s.timestamp >= startMs && s.timestamp <= endMs
    );
  }

  /**
   * Get aggregate statistics
   */
  getStats(): {
    totalSessions: number;
    oldestSession: number | null;
    newestSession: number | null;
    baselineCount: number;
    currentConfig: MetricsCollectorConfig;
  } {
    return {
      totalSessions: this.sessions.length,
      oldestSession: this.sessions.length > 0 ? this.sessions[0].timestamp : null,
      newestSession:
        this.sessions.length > 0 ? this.sessions[this.sessions.length - 1].timestamp : null,
      baselineCount: this.baselines.size,
      currentConfig: this.getConfig(),
    };
  }

  // ============================================
  // Utility Methods
  // ============================================

  private avg(sessions: SessionMetrics[], key: keyof SessionMetrics): number {
    if (sessions.length === 0) return 0;
    const sum = sessions.reduce((acc, s) => acc + (Number(s[key]) || 0), 0);
    return sum / sessions.length;
  }

  private sum(sessions: SessionMetrics[], key: keyof SessionMetrics): number {
    return sessions.reduce((acc, s) => acc + (Number(s[key]) || 0), 0);
  }

  private rate(sessions: SessionMetrics[], key: keyof SessionMetrics): number {
    if (sessions.length === 0) return 0;
    const count = sessions.filter((s) => Boolean(s[key])).length;
    return count / sessions.length;
  }

  private percentChange(baseline: number, current: number, lowerIsBetter: boolean): number {
    if (baseline === 0) return current === 0 ? 0 : lowerIsBetter ? -100 : 100;

    const change = ((baseline - current) / baseline) * 100;
    return lowerIsBetter ? change : -change;
  }

  private pruneOldSessions(): void {
    // Prune by count
    if (this.sessions.length > this.config.maxStoredSessions) {
      const excess = this.sessions.length - this.config.maxStoredSessions;
      this.sessions = this.sessions.slice(excess);
    }

    // Prune by age
    const retentionMs = this.config.retentionDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionMs;
    this.sessions = this.sessions.filter((s) => s.timestamp > cutoff);
  }
}

// ============================================
// Singleton Getter
// ============================================

export function getMetricsCollector(config?: Partial<MetricsCollectorConfig>): MetricsCollector {
  return MetricsCollector.getInstance(config);
}

// ============================================
// Convenience: Get Outcome Tracker Integration Helper
// ============================================

export function getOutcomeTracker() {
  // Lazy import to avoid circular dependencies
  const { OutcomeTracker } = require('./outcome-tracker');
  return OutcomeTracker.getInstance();
}
