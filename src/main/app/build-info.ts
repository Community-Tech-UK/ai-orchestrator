import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AppBuildInfoSchema, type AppBuildInfo } from '@contracts/schemas/observability';
import { getLogger } from '../logging/logger';
import type { SqliteDriver } from '../db/sqlite-driver';
const startupStamp = (() => {
  try { return readFileSync(path.resolve(__dirname, '../../build-info.json'), 'utf8'); }
  catch { return null; }
})();

export function readMigrationLevels(memoryDb: SqliteDriver, loopDb: SqliteDriver | null): AppBuildInfo['migrations'] {
  return [
    { name: 'Memory database', db: memoryDb, sql: 'SELECT name AS level FROM _migrations ORDER BY id DESC LIMIT 1' },
    { name: 'Loops and queue', db: loopDb, sql: 'SELECT MAX(version) AS level FROM loop_migrations' },
  ].map(({ name, db, sql }) => {
    try {
      const row = db?.prepare(sql).get<{ level: string | number | null }>();
      return { name, level: row?.level == null ? null : String(row.level) };
    } catch {
      getLogger('BuildInfo').warn('Migration level unavailable', { database: name });
      return { name, level: null };
    }
  });
}

/** Read the stamp emitted with the running binary, never the working checkout. */
export function readBuildInfo(
  version: string,
  dataFolder: string,
  readStamp = () => {
    if (startupStamp === null) throw new Error('Build stamp unavailable');
    return startupStamp;
  },
): AppBuildInfo {
  try {
    return AppBuildInfoSchema.parse({ ...JSON.parse(readStamp()), version, dataFolder });
  } catch {
    getLogger('BuildInfo').warn('Build provenance is unavailable or invalid');
    return { version, dataFolder, builtAt: null, branch: null, commit: null, dirty: null, migrations: [] };
  }
}
