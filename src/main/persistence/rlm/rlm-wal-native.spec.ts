import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Use Electron only as a Node runtime, matching the production SQLite ABI.
// A single worker owns a real lock; no window, provider or user profile opens.
const lockScript = String.raw`
  require('tsx/cjs');
  const { Worker } = require('node:worker_threads');
  const { mkdtempSync, rmSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const { defaultDriverFactory } = require('./src/main/db/better-sqlite3-driver.ts');
  const { enableRlmWal } = require('./src/main/persistence/rlm/rlm-schema.ts');
  const persistent = process.argv[1] === 'persistent';
  const scratch = mkdtempSync(join(tmpdir(), 'rlm-wal-native-'));
  const filename = join(scratch, 'rlm.db');
  const db = defaultDriverFactory(filename);
  db.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('original')");
  const flags = new Int32Array(new SharedArrayBuffer(12));
  const worker = new Worker(
    "const { workerData } = require('node:worker_threads');" +
    "const Database = require(workerData.modulePath);" +
    "const flags = new Int32Array(workerData.flags);" +
    "const db = new Database(workerData.filename);" +
    "const reader = new Database(workerData.filename);" +
    "try {" +
    "  db.exec('BEGIN IMMEDIATE');" +
    "  Atomics.store(flags, 0, 1); Atomics.notify(flags, 0);" +
    "  Atomics.wait(flags, 2, 0, 10000);" +
    "  Atomics.wait(flags, 1, 0, workerData.persistent ? 4500 : 200);" +
    // Take the read lock before giving up the write lock: a writer lock still admits readers,
    // and releasing first would leave a moment in which the journal mode can change.
    "  if (workerData.persistent) {" +
    "    reader.exec('BEGIN'); reader.prepare('SELECT * FROM preserved').all();" +
    "    db.exec('ROLLBACK');" +
    "    Atomics.wait(flags, 1, 0, 15000);" +
    "    reader.exec('ROLLBACK');" +
    "  } else db.exec('ROLLBACK');" +
    "} finally { reader.close(); db.close(); }",
    { eval: true, workerData: { filename, flags: flags.buffer, persistent,
      modulePath: require.resolve('better-sqlite3') } }
  );
  const done = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', code => code === 0 ? resolve() : reject(new Error('holder exit ' + code)));
  });
  (async () => {
    try {
      if (Atomics.wait(flags, 0, 0, 10000) === 'timed-out') throw new Error('holder not ready');
      let rawCode;
      try { db.pragma('journal_mode = WAL'); } catch (error) { rawCode = error.code; }
      Atomics.store(flags, 2, 1); Atomics.notify(flags, 2);
      const start = performance.now();
      let failure;
      try { enableRlmWal(db); } catch (error) {
        failure = { code: error.code, message: error.message };
      }
      const elapsed = performance.now() - start;
      const timeout = db.pragma('busy_timeout', { simple: true });
      Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
      await done;
      // The same connection can recover after an exhausted retry budget.
      enableRlmWal(db);
      console.log(JSON.stringify({ rawCode, failure, elapsed, timeout,
        mode: db.pragma('journal_mode', { simple: true }),
        row: db.prepare('SELECT value FROM preserved').get() }));
    } finally {
      Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
      await worker.terminate();
      db.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
`;

function runLockHolder(mode: 'transient' | 'persistent'): {
  rawCode: string; failure?: { code?: string; message: string }; elapsed: number; timeout: number;
  mode: string; row: { value: string };
} {
  const electron = createRequire(import.meta.url)('electron') as string;
  return JSON.parse(execFileSync(electron, ['-e', lockScript, mode], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 25000,
  }));
}

describe('RLM WAL native startup contention', () => {
  it('recovers from a real writer lock that bypasses the native busy timeout', () => {
    const result = runLockHolder('transient');
    expect(result.rawCode).toBe('SQLITE_BUSY');
    expect(result.failure).toBeUndefined();
    expect(result.timeout).toBe(5000);
    expect(result.mode).toBe('wal');
    expect(result.row).toEqual({ value: 'original' });
  }, 30000);

  it('bounds total waiting when a writer becomes a persistent reader', () => {
    const result = runLockHolder('persistent');
    expect(result.rawCode).toBe('SQLITE_BUSY');
    expect(result.failure).toMatchObject({ code: 'SQLITE_BUSY' });
    expect(result.elapsed).toBeGreaterThanOrEqual(4900);
    // Allow scheduling slack on shared hosts; a second native timeout takes ~9.5s.
    expect(result.elapsed).toBeLessThan(7500);
    expect(result.timeout).toBe(5000);
    expect(result.mode).toBe('wal');
    expect(result.row).toEqual({ value: 'original' });
  }, 30000);
});
