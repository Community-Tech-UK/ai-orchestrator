import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

// Expose the in-memory db instance so we can close it between tests
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
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { KnowledgeGraphService, getKnowledgeGraphService } from '../../../main/memory/knowledge-graph-service';

describe('KnowledgeGraphService', () => {
  beforeEach(() => {
    // Close the DB to force fresh re-creation, then reset the singleton
    if (_testDb?.open) {
      _testDb.close();
    }
    _testDb = undefined;
    KnowledgeGraphService._resetForTesting();
  });

  // ── Singleton pattern ────────────────────────────────────────────────────

  describe('singleton pattern', () => {
    it('getInstance returns the same instance each time', () => {
      const a = KnowledgeGraphService.getInstance();
      const b = KnowledgeGraphService.getInstance();
      expect(a).toBe(b);
    });

    it('getKnowledgeGraphService convenience getter returns the singleton', () => {
      const svc = getKnowledgeGraphService();
      expect(svc).toBe(KnowledgeGraphService.getInstance());
    });

    it('_resetForTesting creates a new instance after reset', () => {
      const before = KnowledgeGraphService.getInstance();
      KnowledgeGraphService._resetForTesting();
      const after = KnowledgeGraphService.getInstance();
      expect(before).not.toBe(after);
    });
  });

  // ── addFact + queryEntity ────────────────────────────────────────────────

  describe('addFact + queryEntity', () => {
    it('adds a fact and retrieves it via queryEntity', () => {
      const svc = KnowledgeGraphService.getInstance();
      const id = svc.addFact('Alice', 'works_at', 'Acme Corp', { validFrom: '2020-01-01' });

      expect(id).toMatch(/^t_alice_works_at_acme_corp_/);

      const results = svc.queryEntity('Alice', { direction: 'outgoing' });
      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe('Alice');
      expect(results[0].predicate).toBe('works_at');
      expect(results[0].object).toBe('Acme Corp');
      expect(results[0].current).toBe(true);
    });

    it('returns duplicate id for same active triple', () => {
      const svc = KnowledgeGraphService.getInstance();
      const id1 = svc.addFact('Alice', 'works_at', 'Acme Corp');
      const id2 = svc.addFact('Alice', 'works_at', 'Acme Corp');
      expect(id1).toBe(id2);
    });
  });

  // ── Temporal invalidation ────────────────────────────────────────────────

  describe('temporal invalidation', () => {
    it('addFact, invalidate, addFact again — asOf query shows correct current fact', () => {
      const svc = KnowledgeGraphService.getInstance();

      svc.addFact('Alice', 'works_at', 'Acme Corp', { validFrom: '2020-01-01' });
      svc.invalidateFact('Alice', 'works_at', 'Acme Corp', '2022-12-31');
      svc.addFact('Alice', 'works_at', 'NewCo', { validFrom: '2023-01-01' });

      // As of 2021 — should see Acme Corp
      const past = svc.queryEntity('Alice', { direction: 'outgoing', asOf: '2021-06-01' });
      const pastPredicates = past.map(r => r.object);
      expect(pastPredicates).toContain('Acme Corp');
      expect(pastPredicates).not.toContain('NewCo');

      // Current — should see NewCo
      const current = svc.queryEntity('Alice', { direction: 'outgoing' });
      const currentObjects = current.map(r => r.object);
      expect(currentObjects).toContain('NewCo');
    });

    it('invalidateFact returns number of changed rows', () => {
      const svc = KnowledgeGraphService.getInstance();
      svc.addFact('Bob', 'knows', 'Charlie');

      const changed = svc.invalidateFact('Bob', 'knows', 'Charlie', '2023-01-01');
      expect(changed).toBe(1);

      // Double invalidation returns 0
      const changed2 = svc.invalidateFact('Bob', 'knows', 'Charlie', '2023-01-01');
      expect(changed2).toBe(0);
    });
  });

  // ── getTimeline ──────────────────────────────────────────────────────────

  describe('getTimeline', () => {
    it('returns all facts in chronological order', () => {
      const svc = KnowledgeGraphService.getInstance();

      svc.addFact('Alice', 'works_at', 'Acme Corp', { validFrom: '2022-01-01' });
      svc.addFact('Alice', 'child_of', 'Bob', { validFrom: '2000-01-01' });
      svc.addFact('Bob', 'manages', 'Alice'); // no validFrom → null → last

      const timeline = svc.getTimeline();
      expect(timeline).toHaveLength(3);
      expect(timeline[0].validFrom).toBe('2000-01-01');
      expect(timeline[1].validFrom).toBe('2022-01-01');
      expect(timeline[2].validFrom).toBeNull();
    });

    it('filters by entity when entityName is provided', () => {
      const svc = KnowledgeGraphService.getInstance();

      svc.addFact('Alice', 'works_at', 'Acme Corp', { validFrom: '2020-01-01' });
      svc.addFact('Charlie', 'knows', 'Dave', { validFrom: '2021-01-01' });

      const timeline = svc.getTimeline('Alice');
      expect(timeline).toHaveLength(1);
      expect(timeline[0].subject).toBe('Alice');
    });

    it('respects limit parameter', () => {
      const svc = KnowledgeGraphService.getInstance();

      for (let i = 0; i < 5; i++) {
        svc.addFact('Alice', `rel_${i}`, `Entity${i}`, { validFrom: `202${i}-01-01` });
      }

      const timeline = svc.getTimeline(undefined, 3);
      expect(timeline).toHaveLength(3);
    });
  });

  // ── Events ───────────────────────────────────────────────────────────────

  describe('events', () => {
    it('emits graph:fact-added when a fact is added', () => {
      const svc = KnowledgeGraphService.getInstance();
      const events: unknown[] = [];

      svc.on('graph:fact-added', (payload) => events.push(payload));

      svc.addFact('Alice', 'works_at', 'Acme Corp');

      expect(events).toHaveLength(1);
      const event = events[0] as { tripleId: string; subject: string; predicate: string; object: string };
      expect(event.subject).toBe('Alice');
      expect(event.predicate).toBe('works_at');
      expect(event.object).toBe('Acme Corp');
      expect(typeof event.tripleId).toBe('string');
    });

    it('emits graph:fact-invalidated when a fact is invalidated', () => {
      const svc = KnowledgeGraphService.getInstance();
      const events: unknown[] = [];

      svc.on('graph:fact-invalidated', (payload) => events.push(payload));

      svc.addFact('Bob', 'knows', 'Charlie');
      svc.invalidateFact('Bob', 'knows', 'Charlie', '2023-01-01');

      expect(events).toHaveLength(1);
      const event = events[0] as { subject: string; predicate: string; object: string };
      expect(event.subject).toBe('Bob');
    });

    it('does not emit graph:fact-invalidated when no rows changed', () => {
      const svc = KnowledgeGraphService.getInstance();
      const events: unknown[] = [];

      svc.on('graph:fact-invalidated', (payload) => events.push(payload));

      // No fact added — invalidate returns 0 changes
      svc.invalidateFact('Nobody', 'knows', 'Nothing');

      expect(events).toHaveLength(0);
    });
  });

  // ── getStats ─────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('returns zero counts on empty database', () => {
      const svc = KnowledgeGraphService.getInstance();
      const stats = svc.getStats();
      expect(stats.entities).toBe(0);
      expect(stats.triples).toBe(0);
      expect(stats.currentFacts).toBe(0);
      expect(stats.expiredFacts).toBe(0);
      expect(stats.relationshipTypes).toHaveLength(0);
    });

    it('returns correct counts after adding and invalidating facts', () => {
      const svc = KnowledgeGraphService.getInstance();

      svc.addFact('Alice', 'works_at', 'Acme Corp', { validFrom: '2020-01-01' });
      svc.addFact('Alice', 'child_of', 'Bob');
      svc.invalidateFact('Alice', 'works_at', 'Acme Corp', '2022-12-31');

      const stats = svc.getStats();
      // Entities: Alice, Acme Corp, Bob = 3
      expect(stats.entities).toBe(3);
      expect(stats.triples).toBe(2);
      expect(stats.currentFacts).toBe(1);
      expect(stats.expiredFacts).toBe(1);
      expect(stats.relationshipTypes).toEqual(['child_of', 'works_at']);
    });
  });
});
