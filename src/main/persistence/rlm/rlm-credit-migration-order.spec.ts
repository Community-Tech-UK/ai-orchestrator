import { describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import { computeMigrationChecksum, createMigrationsTable, createTables, getSchemaInfo, MIGRATIONS, runMigrations } from './rlm-schema';

describe('Copilot credit migration order and persisted upgrade compatibility', () => {
  it('retains the checksum stored by each historical credit migration name', () => {
    const credits = MIGRATIONS.find(migration => migration.name.endsWith('_copilot_credits'))!;
    // Extracted from the 078 (04d670566/ec52677f9) and 081 (d716aefb9) Git objects.
    expect(computeMigrationChecksum(credits)).toBe('dc0cf22e531bfd9a');
  });
  it('registers the credit migration last, under a number no other migration uses', () => {
    // Main already carries several migrations that share a number (081 twice, for example),
    // so uniqueness across the whole list is not a rule here; only the credit number is.
    const credits = MIGRATIONS.at(-1)!;
    expect(credits.name).toBe('084_copilot_credits');
    const others = MIGRATIONS.slice(0, -1).map(migration => Number(migration.name.split('_')[0]));
    expect(Math.max(...others)).toBeLessThan(84);
  });

  it.each([
    { legacyName: '078_copilot_credits', corrupt: false },
    { legacyName: '078_copilot_credits', corrupt: true },
    { legacyName: '081_copilot_credits', corrupt: false },
    { legacyName: '081_copilot_credits', corrupt: true },
    { legacyName: '082_copilot_credits', corrupt: false },
    { legacyName: '082_copilot_credits', corrupt: true },
  ])('preserves $legacyName (corrupt checksum: $corrupt)', ({ legacyName, corrupt }) => {
    const db = defaultDriverFactory(':memory:');
    try {
      createTables(db); createMigrationsTable(db); runMigrations(db);
      const current = MIGRATIONS.find(migration => migration.name.endsWith('_copilot_credits'))!;
      db.prepare('UPDATE _migrations SET name = ? WHERE name = ?').run(legacyName, current.name);
      const before = db.prepare('SELECT * FROM _migrations WHERE name = ?').get(legacyName);
      db.prepare(`INSERT INTO cost_entries (id, instance_id, session_id, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, cost, timestamp, ai_credits_nano)
        VALUES ('fixture', 'instance', 'session', 'model', 0, 0, 0, 0, 0, 0, 1, 123)`).run();
      if (corrupt) {
        db.prepare('UPDATE _migrations SET checksum = ? WHERE name = ?').run('invalid-checksum', legacyName);
        expect(() => runMigrations(db)).toThrow('Migration checksum mismatch');
      } else {
        runMigrations(db);
        expect(db.prepare('SELECT * FROM _migrations WHERE name = ?').get(legacyName)).toEqual(before);
        expect(getSchemaInfo(db, 1).pendingMigrations).toEqual([]);
        expect(db.prepare('SELECT ai_credits_nano FROM cost_entries WHERE id = ?').get('fixture')).toEqual({ ai_credits_nano: 123 });
      }
    } finally { db.close(); }
  });
});
