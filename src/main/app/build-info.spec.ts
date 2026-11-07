import { describe, expect, it } from 'vitest';
import { readBuildInfo, readMigrationLevels } from './build-info';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';

describe('readBuildInfo', () => {
  it('reads loop migration levels from their separate database', () => {
    const memory = defaultDriverFactory(':memory:');
    const loops = defaultDriverFactory(':memory:');
    try {
      memory.exec("CREATE TABLE _migrations (id INTEGER, name TEXT); INSERT INTO _migrations VALUES (1, 'fixture_migration')");
      loops.exec('CREATE TABLE loop_migrations (version INTEGER); INSERT INTO loop_migrations VALUES (31)');
      expect(readMigrationLevels(memory, loops)).toEqual([
        { name: 'Memory database', level: 'fixture_migration' }, { name: 'Loops and queue', level: '31' },
      ]);
    } finally { memory.close(); loops.close(); }
  });

  it('reports actual applied migration records and leaves missing tables unverified', () => {
    const db = defaultDriverFactory(':memory:');
    try {
      expect(readMigrationLevels(db, db).every(row => row.level === null)).toBe(true);
      db.exec("CREATE TABLE _migrations (id INTEGER, name TEXT); INSERT INTO _migrations VALUES (1, 'fixture_migration'); CREATE TABLE loop_migrations (version INTEGER); INSERT INTO loop_migrations VALUES (3)");
      expect(readMigrationLevels(db, db)).toEqual([{ name: 'Memory database', level: 'fixture_migration' }, { name: 'Loops and queue', level: '3' }]);
      expect(readMigrationLevels(db, null)[1]).toEqual({ name: 'Loops and queue', level: null });
    } finally { db.close(); }
  });
  it('reports the running app paths and immutable build stamp without consulting the current checkout', () => {
    const info = readBuildInfo('1.2.3', '/fixture/data', () => JSON.stringify({ builtAt: '2026-11-02T12:00:00.000Z', branch: 'main', commit: 'a'.repeat(40), dirty: true }));
    expect(info).toMatchObject({ version: '1.2.3', dataFolder: '/fixture/data', branch: 'main', dirty: true });
  });
  it('reports missing or invalid build provenance as unverified', () => {
    expect(readBuildInfo('1', '/fixture/data', () => { throw new Error('missing'); }).commit).toBeNull();
    expect(readBuildInfo('1', '/fixture/data', () => '{}').builtAt).toBeNull();
  });
});
