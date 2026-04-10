// src/tests/unit/memory/knowledge-bridge.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

let _testDb: InstanceType<typeof Database> | undefined;

vi.mock('../../../main/persistence/rlm-database', async () => {
  const BetterSQLite3 = (await import('better-sqlite3')).default;
  const schema = await import('../../../main/persistence/rlm/rlm-schema');
  return {
    getRLMDatabase: () => ({
      getRawDb: () => {
        if (!_testDb || !_testDb.open) {
          _testDb = new BetterSQLite3(':memory:');
          _testDb.pragma('foreign_keys = ON');
          schema.createTables(_testDb);
          schema.createMigrationsTable(_testDb);
          schema.runMigrations(_testDb);
        }
        return _testDb;
      },
    }),
  };
});

vi.mock('../../../main/logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { KnowledgeBridge } from '../../../main/memory/knowledge-bridge';
import { KnowledgeGraphService } from '../../../main/memory/knowledge-graph-service';
import { WakeContextBuilder } from '../../../main/memory/wake-context-builder';
import type { Reflection } from '../../../main/observation/observation.types';

describe('KnowledgeBridge', () => {
  beforeEach(() => {
    KnowledgeBridge._resetForTesting();
    KnowledgeGraphService._resetForTesting();
    WakeContextBuilder._resetForTesting();
    if (_testDb?.open) {
      _testDb.close();
    }
    _testDb = undefined;
  });

  describe('onReflectionCreated', () => {
    it('should extract KG facts from success patterns', () => {
      const bridge = KnowledgeBridge.getInstance();
      const kg = KnowledgeGraphService.getInstance();

      const reflection: Reflection = {
        id: 'ref_1',
        title: 'typescript pattern',
        insight: 'TypeScript preferred over Python for backend services',
        observationIds: ['obs_1', 'obs_2'],
        patterns: [{
          type: 'success_pattern',
          description: 'Successful pattern observed across 5 signals',
          evidence: ['Used TypeScript for API layer'],
          strength: 0.8,
        }],
        confidence: 0.7,
        applicability: ['typescript', 'backend'],
        createdAt: Date.now(),
        ttl: 3_600_000,
        usageCount: 0,
        effectivenessScore: 0,
        promotedToProcedural: false,
      };

      bridge.onReflectionCreated(reflection);

      const stats = kg.getStats();
      expect(stats.triples).toBeGreaterThanOrEqual(1);
    });

    it('should skip low-confidence reflections', () => {
      const bridge = KnowledgeBridge.getInstance();
      const kg = KnowledgeGraphService.getInstance();

      const reflection: Reflection = {
        id: 'ref_2',
        title: 'weak pattern',
        insight: 'Some weak observation',
        observationIds: ['obs_3'],
        patterns: [],
        confidence: 0.2,
        applicability: ['misc'],
        createdAt: Date.now(),
        ttl: 3_600_000,
        usageCount: 0,
        effectivenessScore: 0,
        promotedToProcedural: false,
      };

      bridge.onReflectionCreated(reflection);

      const stats = kg.getStats();
      expect(stats.triples).toBe(0);
    });
  });

  describe('onPromotedToProcedural', () => {
    it('should create a wake hint from a promoted reflection', () => {
      const bridge = KnowledgeBridge.getInstance();
      const wake = WakeContextBuilder.getInstance();

      const reflection: Reflection = {
        id: 'ref_3',
        title: 'deploy pattern',
        insight: 'Blue-green deploys with GitHub Actions are reliable',
        observationIds: ['obs_4', 'obs_5', 'obs_6'],
        patterns: [{
          type: 'success_pattern',
          description: 'Successful deployment pattern',
          evidence: ['Deploy succeeded 5 times'],
          strength: 0.9,
        }],
        confidence: 0.85,
        applicability: ['deploy', 'devops'],
        createdAt: Date.now(),
        ttl: 3_600_000,
        usageCount: 3,
        effectivenessScore: 0.8,
        promotedToProcedural: true,
      };

      bridge.onPromotedToProcedural(reflection);

      const ctx = wake.generateWakeContext();
      expect(ctx.essentialStory.content).toContain('deploy pattern');
    });
  });

  describe('extractFactsFromReflection', () => {
    it('should extract pattern-type facts', () => {
      const bridge = KnowledgeBridge.getInstance();
      const kg = KnowledgeGraphService.getInstance();

      const reflection: Reflection = {
        id: 'ref_4',
        title: 'error handling pattern',
        insight: 'Try-catch with specific error types prevents cascading failures',
        observationIds: ['obs_7'],
        patterns: [
          {
            type: 'success_pattern',
            description: 'Error handling success',
            evidence: ['Caught TypeError before propagation'],
            strength: 0.75,
          },
          {
            type: 'failure_pattern',
            description: 'Unhandled promise rejections cause crashes',
            evidence: ['Process exited with unhandled rejection'],
            strength: 0.6,
          },
        ],
        confidence: 0.65,
        applicability: ['error_handling', 'reliability'],
        createdAt: Date.now(),
        ttl: 3_600_000,
        usageCount: 0,
        effectivenessScore: 0,
        promotedToProcedural: false,
      };

      bridge.onReflectionCreated(reflection);

      // Should create facts for each pattern with strength >= 0.5
      const stats = kg.getStats();
      expect(stats.triples).toBeGreaterThanOrEqual(2);
    });
  });
});
