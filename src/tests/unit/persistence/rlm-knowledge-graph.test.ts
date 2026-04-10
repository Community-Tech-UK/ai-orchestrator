import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as kgPersistence from '../../../main/persistence/rlm/rlm-knowledge-graph';
import { createTables, createMigrationsTable, runMigrations } from '../../../main/persistence/rlm/rlm-schema';

describe('rlm-knowledge-graph persistence', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── normalizeEntityId ──────────────────────────────────────────────────────

  describe('normalizeEntityId', () => {
    it('lowercases the name', () => {
      expect(kgPersistence.normalizeEntityId('Alice')).toBe('alice');
    });

    it('replaces spaces with underscores', () => {
      expect(kgPersistence.normalizeEntityId('Acme Corp')).toBe('acme_corp');
    });

    it('removes apostrophes', () => {
      expect(kgPersistence.normalizeEntityId("O'Brien")).toBe('obrien');
    });

    it('handles combined transformations', () => {
      expect(kgPersistence.normalizeEntityId("Alice O'Brien Corp")).toBe('alice_obrien_corp');
    });
  });

  // ── upsertEntity ──────────────────────────────────────────────────────────

  describe('upsertEntity', () => {
    it('inserts a new entity and returns its normalized id', () => {
      const id = kgPersistence.upsertEntity(db, 'Alice', 'person', { role: 'developer' });
      expect(id).toBe('alice');

      const row = kgPersistence.getEntity(db, 'alice');
      expect(row).toBeDefined();
      expect(row!.name).toBe('Alice');
      expect(row!.type).toBe('person');
    });

    it('updates an existing entity on re-insert', () => {
      kgPersistence.upsertEntity(db, 'Alice', 'person', { role: 'developer' });
      kgPersistence.upsertEntity(db, 'Alice', 'person', { role: 'manager' });

      const rows = kgPersistence.listEntities(db);
      expect(rows).toHaveLength(1);
      const props = JSON.parse(rows[0].properties_json);
      expect(props.role).toBe('manager');
    });

    it('uses "unknown" as default type', () => {
      kgPersistence.upsertEntity(db, 'SomeEntity');
      const row = kgPersistence.getEntity(db, 'someentity');
      expect(row!.type).toBe('unknown');
    });
  });

  // ── addTriple ─────────────────────────────────────────────────────────────

  describe('addTriple', () => {
    it('creates a triple and auto-creates both entities', () => {
      const id = kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'works_at',
        object: 'Acme Corp',
        validFrom: '2020-01-01',
      });

      expect(id).toMatch(/^t_alice_works_at_acme_corp_/);
      expect(kgPersistence.getEntity(db, 'alice')).toBeDefined();
      expect(kgPersistence.getEntity(db, 'acme_corp')).toBeDefined();
    });

    it('returns existing id on duplicate (same subject+predicate+object, valid_to IS NULL)', () => {
      const id1 = kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'works_at',
        object: 'Acme Corp',
      });
      const id2 = kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'works_at',
        object: 'Acme Corp',
      });

      expect(id1).toBe(id2);
    });

    it('allows re-adding a triple after invalidation', () => {
      const id1 = kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'works_at',
        object: 'Acme Corp',
      });

      kgPersistence.invalidateTriple(db, 'Alice', 'works_at', 'Acme Corp', '2023-12-31');

      const id2 = kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'works_at',
        object: 'Acme Corp',
        validFrom: '2024-01-01',
      });

      expect(id2).not.toBe(id1);
    });

    it('normalizes predicate casing and spaces', () => {
      const id = kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'Works At',
        object: 'Acme Corp',
      });
      // duplicate detection should work with normalized predicate
      const id2 = kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'works_at',
        object: 'Acme Corp',
      });
      expect(id).toBe(id2);
    });
  });

  // ── invalidateTriple ──────────────────────────────────────────────────────

  describe('invalidateTriple', () => {
    it('sets valid_to on the active triple and returns changes count', () => {
      kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'works_at',
        object: 'Acme Corp',
      });

      const changes = kgPersistence.invalidateTriple(db, 'Alice', 'works_at', 'Acme Corp', '2023-12-31');
      expect(changes).toBe(1);

      const results = kgPersistence.queryEntity(db, 'Alice');
      expect(results[0].current).toBe(false);
      expect(results[0].validTo).toBe('2023-12-31');
    });

    it('returns 0 when no active triple exists', () => {
      kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'works_at',
        object: 'Acme Corp',
      });
      kgPersistence.invalidateTriple(db, 'Alice', 'works_at', 'Acme Corp', '2023-12-31');

      // Already invalidated — calling again returns 0
      const changes = kgPersistence.invalidateTriple(db, 'Alice', 'works_at', 'Acme Corp', '2023-12-31');
      expect(changes).toBe(0);
    });
  });

  // ── queryEntity ───────────────────────────────────────────────────────────

  describe('queryEntity', () => {
    beforeEach(() => {
      // Alice works_at Acme Corp (active)
      kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'works_at',
        object: 'Acme Corp',
        validFrom: '2020-01-01',
      });
      // Alice child_of Bob (active, no dates)
      kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'child_of',
        object: 'Bob',
      });
      // Bob manages Alice (incoming for Alice)
      kgPersistence.addTriple(db, {
        subject: 'Bob',
        predicate: 'manages',
        object: 'Alice',
        validFrom: '2021-06-01',
      });
    });

    it('returns outgoing facts for entity', () => {
      const results = kgPersistence.queryEntity(db, 'Alice', { direction: 'outgoing' });
      expect(results).toHaveLength(2);
      expect(results.every(r => r.direction === 'outgoing')).toBe(true);
      expect(results.every(r => r.subject === 'Alice')).toBe(true);
    });

    it('returns incoming facts for entity', () => {
      const results = kgPersistence.queryEntity(db, 'Alice', { direction: 'incoming' });
      expect(results).toHaveLength(1);
      expect(results[0].direction).toBe('incoming');
      expect(results[0].subject).toBe('Bob');
      expect(results[0].predicate).toBe('manages');
    });

    it('returns both directions by default', () => {
      const results = kgPersistence.queryEntity(db, 'Alice');
      expect(results).toHaveLength(3);
    });

    it('filters by asOf — excludes facts not yet started', () => {
      // Query before works_at started (before 2020-01-01)
      const results = kgPersistence.queryEntity(db, 'Alice', {
        direction: 'outgoing',
        asOf: '2019-12-31',
      });
      // works_at has valid_from = '2020-01-01', so it should be excluded
      // child_of has NULL valid_from so it should be included
      const predicates = results.map(r => r.predicate);
      expect(predicates).not.toContain('works_at');
      expect(predicates).toContain('child_of');
    });

    it('marks current=true when valid_to is null', () => {
      const results = kgPersistence.queryEntity(db, 'Alice', { direction: 'outgoing' });
      expect(results.every(r => r.current === true)).toBe(true);
    });

    it('marks current=false after invalidation', () => {
      kgPersistence.invalidateTriple(db, 'Alice', 'works_at', 'Acme Corp', '2022-12-31');
      const results = kgPersistence.queryEntity(db, 'Alice', { direction: 'outgoing' });
      const worksAt = results.find(r => r.predicate === 'works_at');
      expect(worksAt!.current).toBe(false);
    });
  });

  // ── timeline ──────────────────────────────────────────────────────────────

  describe('timeline', () => {
    it('returns all triples in chronological order (valid_from ASC, nulls last)', () => {
      kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'works_at',
        object: 'Acme Corp',
        validFrom: '2022-01-01',
      });
      kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'child_of',
        object: 'Bob',
        validFrom: '2000-01-01',
      });
      kgPersistence.addTriple(db, {
        subject: 'Bob',
        predicate: 'manages',
        object: 'Alice',
        // no valid_from → null → should appear last
      });

      const results = kgPersistence.timeline(db);
      expect(results).toHaveLength(3);
      // First two have dates, last has null
      expect(results[0].validFrom).toBe('2000-01-01');
      expect(results[1].validFrom).toBe('2022-01-01');
      expect(results[2].validFrom).toBeNull();
    });

    it('filters by entity name when provided', () => {
      kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'works_at',
        object: 'Acme Corp',
        validFrom: '2020-01-01',
      });
      kgPersistence.addTriple(db, {
        subject: 'Charlie',
        predicate: 'knows',
        object: 'Dave',
        validFrom: '2021-01-01',
      });

      const results = kgPersistence.timeline(db, 'Alice');
      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe('Alice');
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        kgPersistence.addTriple(db, {
          subject: 'Alice',
          predicate: `rel_${i}`,
          object: `Entity${i}`,
          validFrom: `202${i}-01-01`,
        });
      }

      const results = kgPersistence.timeline(db, undefined, 3);
      expect(results).toHaveLength(3);
    });
  });

  // ── getStats ──────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('returns zero counts on empty database', () => {
      const stats = kgPersistence.getStats(db);
      expect(stats.entities).toBe(0);
      expect(stats.triples).toBe(0);
      expect(stats.currentFacts).toBe(0);
      expect(stats.expiredFacts).toBe(0);
      expect(stats.relationshipTypes).toHaveLength(0);
    });

    it('counts entities, triples, current and expired facts correctly', () => {
      kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'works_at',
        object: 'Acme Corp',
        validFrom: '2020-01-01',
      });
      kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'child_of',
        object: 'Bob',
      });

      // Invalidate one
      kgPersistence.invalidateTriple(db, 'Alice', 'works_at', 'Acme Corp', '2022-12-31');

      const stats = kgPersistence.getStats(db);
      // Entities: Alice, Acme Corp, Bob = 3
      expect(stats.entities).toBe(3);
      expect(stats.triples).toBe(2);
      expect(stats.currentFacts).toBe(1);
      expect(stats.expiredFacts).toBe(1);
      expect(stats.relationshipTypes).toEqual(['child_of', 'works_at']);
    });
  });
});
