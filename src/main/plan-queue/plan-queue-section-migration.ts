/**
 * Migration 054: a plan too big for one job runs one job per step, so one run now holds several jobs for the same
 * document and `UNIQUE (run_id, document_path)` has to go. SQLite cannot drop a constraint, so the table is rebuilt
 * (SQLite's documented copy-and-rename procedure). The runner switches foreign keys off around it: with them on,
 * dropping the old table would delete every row in the history tables that point at it.
 */
import type { SqliteDriver } from '../db/sqlite-driver';

interface Column { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

export function addPlanQueueSections(db: SqliteDriver): void {
  const columns = db.prepare('PRAGMA table_info(plan_queue_items)').all<Column>();
  const names = columns.map(column => column.name);
  // A profile that ran a build which already added the column has it; only the missing constraint is left to remove.
  const hasSection = names.includes('section');
  const oneJobPerDocument = db.prepare('PRAGMA index_list(plan_queue_items)').all<{ name: string; unique: number; origin: string }>()
    .some(index => index.unique === 1 && index.origin === 'u'
      && db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all<{ name: string }>().map(part => part.name).join() === 'run_id,document_path');
  if (oneJobPerDocument) {
    const definitions = columns.map(column => {
      const rule = column.name === 'id' ? ' PRIMARY KEY'
        : column.name === 'run_id' ? ' REFERENCES plan_queue_runs(id) ON DELETE CASCADE' : '';
      return `${column.name} ${column.type}${column.notnull && column.name !== 'id' ? ' NOT NULL' : ''}${column.dflt_value === null ? '' : ` DEFAULT ${column.dflt_value}`}${rule}`;
    });
    const list = names.join(', ');
    db.exec(`
      CREATE TABLE plan_queue_items_rebuilt (${[...definitions, ...(hasSection ? [] : ['section INTEGER'])].join(', ')});
      INSERT INTO plan_queue_items_rebuilt (${list}) SELECT ${list} FROM plan_queue_items;
      DROP TABLE plan_queue_items;
      ALTER TABLE plan_queue_items_rebuilt RENAME TO plan_queue_items;
      CREATE INDEX idx_plan_queue_items_run ON plan_queue_items(run_id, created_at);
      CREATE INDEX idx_plan_queue_items_state ON plan_queue_items(state);
      CREATE INDEX idx_queue_parked_doc ON plan_queue_items(document_path, state, updated_at DESC);
    `);
  } else if (!hasSection) db.exec('ALTER TABLE plan_queue_items ADD COLUMN section INTEGER;');
  // The step number is the job's place within its document; whole-document jobs have none, so they count as one.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_queue_items_step ON plan_queue_items(run_id, document_path, COALESCE(section, -1));');
}
