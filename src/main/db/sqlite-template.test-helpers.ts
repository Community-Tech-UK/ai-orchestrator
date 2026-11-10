import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import type { SqliteDriver } from './sqlite-driver';
import { createSqliteWasmDatabaseWithExport, openSqliteWasmFileCopy } from './sqlite-wasm-driver';

/**
 * A SQLite database built once per spec file and copied into each test. Tests only.
 *
 * Specs that start every test from a freshly migrated database spent most of their set-up running the whole
 * migration chain again (about 65 ms per test for the RLM schema on the Linux test machine, 110 ms on a busy Mac; a
 * copy takes about 1.5 ms). `build` runs once, before the file's first test, on an empty in-memory database; `open()`
 * then returns a separate in-memory copy of the result, so each test still reads and writes only its own database.
 *
 * Only the database file is copied. Connection settings such as `PRAGMA foreign_keys` are not part of it: set them on
 * each copy, as the spec did on its fresh database. Values the migrations take from the clock (`_migrations.applied_at`
 * and the RLM `a0-per-turn-booking-live` marker) are those of the moment the template was built, not of the test, and
 * ignore fake timers set later: a spec whose results depend on them should keep migrating per test. Call
 * `useSqliteTemplate` at the top level of a spec or inside a `describe` body (it registers `beforeAll` and
 * `afterAll`), never inside a test.
 */
export interface SqliteTemplate {
  open(): SqliteDriver;
}

export function useSqliteTemplate(build: (db: SqliteDriver) => void): SqliteTemplate {
  let dir: string | null = null;
  let file: string | null = null;
  beforeAll(() => {
    const { driver, exportBytes } = createSqliteWasmDatabaseWithExport();
    try {
      build(driver);
      dir = mkdtempSync(join(tmpdir(), 'sqlite-template-'));
      file = join(dir, 'template.sqlite');
      writeFileSync(file, exportBytes());
    } finally {
      driver.close();
    }
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  return {
    open(): SqliteDriver {
      if (!file) throw new Error('useSqliteTemplate: open ran before the template was built');
      return openSqliteWasmFileCopy(file);
    },
  };
}
