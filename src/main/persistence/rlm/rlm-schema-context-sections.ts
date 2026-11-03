import type { SqliteDriver } from '../../db/sqlite-driver';

interface TableInfoRow {
  name: string;
}

export function ensureContextSectionSummaryColumns(db: SqliteDriver): void {
  // Legacy profiles may need ALTERs before runMigrations acquires its lock.
  // Serialize discovery as well as writes across the two startup owners.
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db
      .prepare(`PRAGMA table_info(context_sections)`)
      .all() as TableInfoRow[];
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has('pending_summary')) {
      db.exec(`
        ALTER TABLE context_sections
        ADD COLUMN pending_summary INTEGER DEFAULT 0
      `);
    }

    if (!columnNames.has('summary_priority')) {
      db.exec(`
        ALTER TABLE context_sections
        ADD COLUMN summary_priority INTEGER DEFAULT 0
      `);
    }

    if (!columnNames.has('last_summary_attempt')) {
      db.exec(`
        ALTER TABLE context_sections
        ADD COLUMN last_summary_attempt INTEGER
      `);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError],
        `${error instanceof Error ? error.message : String(error)}; ` +
        `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error });
    }
    throw error;
  }
}
