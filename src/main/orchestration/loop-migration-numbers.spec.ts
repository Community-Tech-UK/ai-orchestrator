import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import { PLAN_QUEUE_RESERVED_MIGRATIONS } from '../plan-queue/plan-queue-migrations';
import { LOOP_MIGRATIONS, LOOP_SCHEMA_VERSION, runLoopMigrations } from './loop-schema';
import { findMigrationNumberProblems } from './loop-migration-numbers';

describe('loop migration numbering', () => {
  it('has unique, strictly increasing versions and unique names that start with their version', () => {
    expect(findMigrationNumberProblems(LOOP_MIGRATIONS, PLAN_QUEUE_RESERVED_MIGRATIONS)).toEqual([]);
  });

  it('keeps LOOP_SCHEMA_VERSION equal to the last migration', () => {
    expect(LOOP_MIGRATIONS[LOOP_MIGRATIONS.length - 1].version).toBe(LOOP_SCHEMA_VERSION);
  });

  it('holds the programme numbers above every number already used', () => {
    for (const entry of PLAN_QUEUE_RESERVED_MIGRATIONS) expect(entry.version).toBeGreaterThan(LOOP_SCHEMA_VERSION);
  });

  it('records exactly the versions in the array as receipts on a fresh database', () => {
    const db = new Database(':memory:') as unknown as SqliteDriver;
    try {
      runLoopMigrations(db);
      const rows = db.prepare('SELECT version, name FROM loop_migrations ORDER BY version').all<{ version: number; name: string }>();
      expect(rows).toEqual(LOOP_MIGRATIONS.map(({ version, name }) => ({ version, name })));
    } finally {
      db.close();
    }
  });

  describe('checker catches deliberate mistakes', () => {
    const good = [
      { version: 1, name: '001_a' },
      { version: 2, name: '002_b' },
    ];

    it('accepts a sound list with gaps', () => {
      expect(findMigrationNumberProblems([...good, { version: 30, name: '030_c' }])).toEqual([]);
    });

    it('reports a repeated version', () => {
      expect(findMigrationNumberProblems([...good, { version: 2, name: '002_c' }]).join('\n')).toContain('version 2 is used by both');
    });

    it('reports a repeated name', () => {
      expect(findMigrationNumberProblems([...good, { version: 3, name: '002_b' }]).join('\n')).toContain('name 002_b is used by versions');
    });

    it('reports versions that are not increasing in array order', () => {
      expect(findMigrationNumberProblems([good[1], good[0]]).join('\n')).toContain('does not come after');
    });

    it('reports a name whose number differs from its version', () => {
      expect(findMigrationNumberProblems([...good, { version: 31, name: '032_x' }]).join('\n')).toContain('does not start with its version 31');
    });

    it('reports a reserved number taken by a different migration', () => {
      const reserved = [{ version: 43, name: '043_held', purpose: 'held' }];
      expect(findMigrationNumberProblems([...good, { version: 43, name: '043_other' }], reserved).join('\n'))
        .toContain('reserved version 43 (043_held) is used by 043_other');
      expect(findMigrationNumberProblems([...good, { version: 43, name: '043_held' }], reserved)).toEqual([]);
    });
  });
});
