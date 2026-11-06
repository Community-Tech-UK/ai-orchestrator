// Run with Electron as Node and the freshly compiled test modules directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const compiled = path.resolve(process.argv[2]);
const { defaultDriverFactory } = require(path.join(compiled, 'db/better-sqlite3-driver'));
const { createTables, createMigrationsTable, getAppliedMigrations, MIGRATIONS, runMigrations }
  = require(path.join(compiled, 'persistence/rlm/rlm-schema'));

const directory = fs.mkdtempSync(path.join(compiled, 'database-'));
const connections = [];
try {
  const file = path.join(directory, 'rlm.db');
  const winner = defaultDriverFactory(file);
  connections.push(winner);
  winner.pragma('journal_mode = WAL');
  winner.pragma('foreign_keys = ON');
  createTables(winner);
  createMigrationsTable(winner);
  const follower = defaultDriverFactory(file);
  connections.push(follower);
  follower.pragma('foreign_keys = ON');
  follower.pragma('busy_timeout = 0');
  winner.pragma('busy_timeout = 0');

  let otherOwnerRan = false;
  let ownsWriteLock = false;
  const race = () => {
    if (otherOwnerRan) return;
    otherOwnerRan = true;
    runMigrations(winner);
  };
  const connection = new Proxy(follower, {
    get(target, property) {
      if (property === 'transaction') return operation => {
        race();
        return target.transaction(operation);
      };
      if (property === 'exec') return sql => {
        if (/^BEGIN\b/i.test(sql)) race();
        target.exec(sql);
        if (/^BEGIN\b/i.test(sql)) {
          // A second writer must be refused before migration history is read.
          assert.throws(() => winner.exec('BEGIN IMMEDIATE'), /database is locked/);
          ownsWriteLock = true;
        }
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const applied = [];
  runMigrations(connection, name => applied.push(name));
  assert.equal(otherOwnerRan, true);
  assert.equal(ownsWriteLock, true);
  assert.deepEqual(applied, []);
  assert.deepEqual(getAppliedMigrations(follower).map(row => row.name), MIGRATIONS.map(m => m.name));

  // Fully migrated WAL databases must remain readable behind another writer.
  winner.exec('BEGIN IMMEDIATE');
  try {
    runMigrations(follower);
  } finally {
    winner.exec('ROLLBACK');
  }
  console.log(JSON.stringify({ twoConnections: true, staleDiscovery: 'safe',
    writeLockBeforeRead: true, currentDatabaseWithoutWriteLock: true }));
} finally {
  for (const connection of connections.reverse()) connection.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
