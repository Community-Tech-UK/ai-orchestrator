/**
 * ObservationStore Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ObservationStore, getObservationStore } from './observation-store';

const mockDb = vi.hoisted(() => ({
  addObservation: vi.fn(),
  addReflection: vi.fn(),
  getObservations: vi.fn().mockReturnValue([]),
  getReflections: vi.fn().mockReturnValue([]),
  getReflectionById: vi.fn().mockReturnValue(null),
  updateObservation: vi.fn(),
  updateReflection: vi.fn(),
  deleteExpiredObservations: vi.fn().mockReturnValue(0),
  deleteExpiredReflections: vi.fn().mockReturnValue(0),
  getObservationStats: vi.fn().mockReturnValue({
    totalObservations: 0,
    totalReflections: 0,
    promotedReflections: 0,
    averageConfidence: 0,
    averageEffectiveness: 0,
  }),
}));

const mockVectorStore = vi.hoisted(() => ({
  addSection: vi.fn().mockResolvedValue({}),
  search: vi.fn().mockResolvedValue([]),
}));

// Mock dependencies
vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => mockDb,
}));

vi.mock('../rlm/vector-store', () => ({
  getVectorStore: () => mockVectorStore,
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('ObservationStore', () => {
  let store: ObservationStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getObservations.mockReturnValue([]);
    mockDb.getReflections.mockReturnValue([]);
    mockDb.getReflectionById.mockReturnValue(null);
    mockDb.deleteExpiredObservations.mockReturnValue(0);
    mockDb.deleteExpiredReflections.mockReturnValue(0);
    mockDb.getObservationStats.mockReturnValue({
      totalObservations: 0,
      totalReflections: 0,
      promotedReflections: 0,
      averageConfidence: 0,
      averageEffectiveness: 0,
    });
    mockVectorStore.search.mockResolvedValue([]);
    mockVectorStore.addSection.mockResolvedValue({});
    ObservationStore._resetForTesting();
    store = getObservationStore();
  });

  afterEach(() => {
    ObservationStore._resetForTesting();
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = getObservationStore();
      const instance2 = getObservationStore();
      expect(instance1).toBe(instance2);
    });
  });

  describe('storeObservation', () => {
    it('should store observation and return with generated id', () => {
      const observation = store.storeObservation({
        summary: 'Test observation',
        sourceIds: ['src-1'],
        instanceIds: ['inst-1'],
        themes: ['testing', 'validation'],
        keyFindings: ['Finding 1'],
        successSignals: 3,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 50,
      });

      expect(observation).toBeDefined();
      expect(observation.id).toBeDefined();
      expect(observation.summary).toBe('Test observation');
      expect(observation.themes).toEqual(['testing', 'validation']);
    });

    it('should emit observation:stored event', () => {
      const emitSpy = vi.spyOn(store, 'emit');

      store.storeObservation({
        summary: 'Test',
        sourceIds: [],
        instanceIds: [],
        themes: [],
        keyFindings: [],
        successSignals: 0,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 10,
      });

      expect(emitSpy).toHaveBeenCalledWith('observation:stored', expect.objectContaining({
        id: expect.any(String),
      }));
    });

    it('emits observation:conflict-detected for contradictory observations', () => {
      const now = Date.now();
      mockDb.getObservations.mockReturnValueOnce([{
        id: 'obs-existing',
        summary: 'Feature flag alpha is enabled',
        source_ids_json: '[]',
        instance_ids_json: '[]',
        themes_json: '["feature","flag"]',
        key_findings_json: '["Feature flag alpha enabled"]',
        success_signals: 0,
        failure_signals: 0,
        timestamp: now - 1000,
        created_at: now - 1000,
        ttl: 86400000,
        promoted: 0,
        token_count: 12,
      }]);
      const handler = vi.fn();
      store.on('observation:conflict-detected', handler);

      const observation = store.storeObservation({
        summary: 'Feature flag alpha is disabled',
        sourceIds: [],
        instanceIds: [],
        themes: ['feature', 'flag'],
        keyFindings: ['Feature flag alpha disabled'],
        successSignals: 0,
        failureSignals: 1,
        timestamp: now,
        createdAt: now,
        ttl: 86400000,
        promoted: false,
        tokenCount: 12,
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        observationId: observation.id,
        conflicts: [
          expect.objectContaining({
            existingObservationId: 'obs-existing',
            result: expect.objectContaining({ type: 'antonym' }),
          }),
        ],
      }));
    });
  });

  describe('storeReflection', () => {
    it('should store reflection and return with generated id', () => {
      const reflection = store.storeReflection({
        title: 'Test Pattern',
        insight: 'Use caching for better performance',
        observationIds: ['obs-1', 'obs-2'],
        patterns: [
          {
            type: 'success_pattern',
            description: 'Caching improves speed',
            evidence: ['Fast response time'],
            strength: 0.9,
          },
        ],
        confidence: 0.85,
        applicability: ['general', 'performance'],
        createdAt: Date.now(),
        ttl: 604800000,
        usageCount: 0,
        effectivenessScore: 0,
        promotedToProcedural: false,
      });

      expect(reflection).toBeDefined();
      expect(reflection.id).toBeDefined();
      expect(reflection.title).toBe('Test Pattern');
      expect(reflection.confidence).toBe(0.85);
    });

    it('should emit reflection:stored event', () => {
      const emitSpy = vi.spyOn(store, 'emit');

      store.storeReflection({
        title: 'Test',
        insight: 'Insight',
        observationIds: [],
        patterns: [],
        confidence: 0.5,
        applicability: [],
        createdAt: Date.now(),
        ttl: 100000,
        usageCount: 0,
        effectivenessScore: 0,
        promotedToProcedural: false,
      });

      expect(emitSpy).toHaveBeenCalledWith('reflection:stored', expect.objectContaining({
        id: expect.any(String),
      }));
    });
  });

  describe('configure', () => {
    it('should configure settings', () => {
      store.configure({
        enabled: true,
        observeTokenThreshold: 5000,
        reflectObservationThreshold: 15,
      });

      const config = store.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.observeTokenThreshold).toBe(5000);
      expect(config.reflectObservationThreshold).toBe(15);
    });

    it('should preserve unchanged settings', () => {
      const originalConfig = store.getConfig();
      const originalRingSize = originalConfig.ringBufferSize;

      store.configure({
        enabled: false,
      });

      const newConfig = store.getConfig();
      expect(newConfig.enabled).toBe(false);
      expect(newConfig.ringBufferSize).toBe(originalRingSize);
    });
  });

  describe('getStats', () => {
    it('should get stats', () => {
      const stats = store.getStats();

      expect(stats).toBeDefined();
      expect(stats).toHaveProperty('totalObservations');
      expect(stats).toHaveProperty('totalReflections');
      expect(stats).toHaveProperty('totalInjections');
      expect(stats).toHaveProperty('successfulInjections');
    });
  });

  describe('applyDecay', () => {
    it('should apply decay', () => {
      const result = store.applyDecay();

      expect(result).toBeDefined();
      expect(result).toHaveProperty('expiredObservations');
      expect(result).toHaveProperty('expiredReflections');
      expect(typeof result.expiredObservations).toBe('number');
      expect(typeof result.expiredReflections).toBe('number');
    });
  });

  describe('getObservations', () => {
    it('should get observations from database', () => {
      const observations = store.getObservations({ limit: 10 });

      expect(Array.isArray(observations)).toBe(true);
    });

    it('should respect limit parameter', () => {
      const observations = store.getObservations({ limit: 5 });

      expect(observations.length).toBeLessThanOrEqual(5);
    });
  });

  describe('getReflections', () => {
    it('should get reflections from database', () => {
      const reflections = store.getReflections({ minConfidence: 0.5 });

      expect(Array.isArray(reflections)).toBe(true);
    });
  });

  describe('queryRelevantReflections', () => {
    it('looks up cache-missed vector hits by reflection id instead of querying one arbitrary row', async () => {
      mockVectorStore.search.mockResolvedValueOnce([
        { entry: { sectionId: 'reflection-ref-target' } },
      ]);
      mockDb.getReflections.mockReturnValueOnce([
        reflectionRow({ id: 'ref-other', confidence: 0.99 }),
      ]);
      mockDb.getReflectionById.mockReturnValueOnce(
        reflectionRow({ id: 'ref-target', confidence: 0.8 }),
      );

      const reflections = await store.queryRelevantReflections('cache miss context', {
        topK: 1,
        minConfidence: 0.5,
      });

      expect(reflections).toHaveLength(1);
      expect(reflections[0].id).toBe('ref-target');
      expect(mockDb.getReflectionById).toHaveBeenCalledWith('ref-target');
    });
  });

  describe('recordInjection', () => {
    it('should update injection stats on success', () => {
      const reflection = store.storeReflection({
        title: 'Test',
        insight: 'Insight',
        observationIds: [],
        patterns: [],
        confidence: 0.8,
        applicability: [],
        createdAt: Date.now(),
        ttl: 100000,
        usageCount: 0,
        effectivenessScore: 0,
        promotedToProcedural: false,
      });

      const statsBefore = store.getStats();
      store.recordInjection(reflection.id, true);
      const statsAfter = store.getStats();

      expect(statsAfter.totalInjections).toBe(statsBefore.totalInjections + 1);
      expect(statsAfter.successfulInjections).toBe(statsBefore.successfulInjections + 1);
    });

    it('should emit injection:recorded event', () => {
      const reflection = store.storeReflection({
        title: 'Test',
        insight: 'Insight',
        observationIds: [],
        patterns: [],
        confidence: 0.8,
        applicability: [],
        createdAt: Date.now(),
        ttl: 100000,
        usageCount: 0,
        effectivenessScore: 0,
        promotedToProcedural: false,
      });

      const emitSpy = vi.spyOn(store, 'emit');
      store.recordInjection(reflection.id, true);

      expect(emitSpy).toHaveBeenCalledWith('injection:recorded', expect.objectContaining({
        reflectionId: reflection.id,
        success: true,
      }));
    });
  });
});

function reflectionRow(overrides: Partial<{
  id: string;
  title: string;
  insight: string;
  observation_ids_json: string;
  patterns_json: string;
  confidence: number;
  applicability_json: string;
  created_at: number;
  ttl: number;
  usage_count: number;
  effectiveness_score: number;
  promoted_to_procedural: number;
}> = {}) {
  return {
    id: 'ref-1',
    title: 'Reflection',
    insight: 'Use the direct lookup',
    observation_ids_json: '[]',
    patterns_json: '[]',
    confidence: 0.8,
    applicability_json: '[]',
    created_at: Date.now(),
    ttl: 86_400_000,
    usage_count: 0,
    effectiveness_score: 0,
    promoted_to_procedural: 0,
    ...overrides,
  };
}
