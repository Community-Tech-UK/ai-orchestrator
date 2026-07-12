import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteWasmDatabase } from '../../../db/sqlite-wasm-driver';
import type { SqliteDriver } from '../../../db/sqlite-driver';
import { reconcilePrivateCodexRolloutPaths } from './codex-private-rollout-reconcile';

describe('reconcilePrivateCodexRolloutPaths', () => {
  const roots: string[] = [];
  const closeDrivers: (() => void)[] = [];
  const tempRoots = ['/tmp', 'C:/Temp'];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    for (const close of closeDrivers.splice(0)) {
      close();
    }
  });

  function makeRoot(): string {
    const root = join(tmpdir(), `codex-rollout-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    roots.push(root);
    return root;
  }

  function createDatabase(statePath: string): SqliteDriver {
    writeFileSync(statePath, 'test-database-marker', 'utf-8');
    const db = createSqliteWasmDatabase(statePath);
    const close = db.close.bind(db);
    closeDrivers.push(close);
    db.close = () => {
      // The reconcile owns close(); afterEach releases the shared test driver.
    };
    return db;
  }

  function createPrivateDatabase(statePath: string, sessionsDir: string): SqliteDriver {
    const db = createDatabase(statePath);
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL
      );
    `);
    const persistent = join(sessionsDir, '2026', '07', '09', 'rollout-persistent.jsonl');
    db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(
      'legit',
      '/Users/example/.codex/sessions/rollout-legit.jsonl',
    );
    db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run('persistent', persistent);
    db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(
      'stale-present',
      '/tmp/codex-browser-mcp-abc/sessions/2026/07/10/rollout-present.jsonl',
    );
    db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(
      'stale-missing',
      '/tmp/codex-browser-mcp-xyz/sessions/2026/07/11/rollout-missing.jsonl',
    );
    return db;
  }

  const presentOnly = (path: string) => path.includes('rollout-present.jsonl');

  it('rewrites stale temp-home rows with an existing persistent file and leaves the rest', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const sessionsDir = join(root, 'aio-sessions');
    const backupDir = join(root, 'backups');
    const db = createPrivateDatabase(statePath, sessionsDir);

    const result = reconcilePrivateCodexRolloutPaths({
      privateStatePath: statePath,
      sessionsDir,
      backupDir,
      tempRoots,
      fileExists: presentOnly,
      driverFactory: () => db,
      createBackup: (_source, backupPath) => writeFileSync(backupPath, 'backup', 'utf-8'),
      now: () => 1_752_192_000_000,
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'reconciled',
      candidates: 2,
      rewritten: 1,
      skippedMissingFile: 1,
    });
    expect(existsSync((result as { backupPath: string }).backupPath)).toBe(true);

    expect(db.prepare('SELECT id, rollout_path FROM threads ORDER BY id').all()).toEqual([
      { id: 'legit', rollout_path: '/Users/example/.codex/sessions/rollout-legit.jsonl' },
      { id: 'persistent', rollout_path: join(sessionsDir, '2026', '07', '09', 'rollout-persistent.jsonl') },
      { id: 'stale-missing', rollout_path: '/tmp/codex-browser-mcp-xyz/sessions/2026/07/11/rollout-missing.jsonl' },
      { id: 'stale-present', rollout_path: join(sessionsDir, '2026', '07', '10', 'rollout-present.jsonl') },
    ]);
  });

  it('is idempotent: a second run finds no stale rows', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const sessionsDir = join(root, 'aio-sessions');
    const db = createPrivateDatabase(statePath, sessionsDir);
    const options = {
      privateStatePath: statePath,
      sessionsDir,
      backupDir: join(root, 'backups'),
      tempRoots,
      fileExists: presentOnly,
      driverFactory: () => db,
      createBackup: (_source: SqliteDriver, backupPath: string) => writeFileSync(backupPath, 'backup', 'utf-8'),
    };
    reconcilePrivateCodexRolloutPaths(options);

    expect(reconcilePrivateCodexRolloutPaths(options)).toEqual({ status: 'skipped', reason: 'no-stale-rows' });
  });

  it('skips when no stale rows have an existing persistent file', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const sessionsDir = join(root, 'aio-sessions');
    const db = createPrivateDatabase(statePath, sessionsDir);

    const result = reconcilePrivateCodexRolloutPaths({
      privateStatePath: statePath,
      sessionsDir,
      backupDir: join(root, 'backups'),
      tempRoots,
      fileExists: () => false,
      driverFactory: () => db,
      createBackup: (_source, backupPath) => writeFileSync(backupPath, 'backup', 'utf-8'),
    });

    expect(result).toEqual({ status: 'skipped', reason: 'no-stale-rows' });
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });

  it('skips a missing private database without creating it', () => {
    const root = makeRoot();
    const statePath = join(root, 'missing.sqlite');

    expect(reconcilePrivateCodexRolloutPaths({
      privateStatePath: statePath,
      sessionsDir: join(root, 'aio-sessions'),
      backupDir: join(root, 'backups'),
      tempRoots,
    })).toEqual({ status: 'skipped', reason: 'missing-database' });
    expect(existsSync(statePath)).toBe(false);
  });

  it('skips an incompatible database without backing it up or mutating it', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const db = createDatabase(statePath);
    db.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('preserve-me');");

    const result = reconcilePrivateCodexRolloutPaths({
      privateStatePath: statePath,
      sessionsDir: join(root, 'aio-sessions'),
      backupDir: join(root, 'backups'),
      tempRoots,
      driverFactory: () => db,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'incompatible-schema' });
    expect(existsSync(join(root, 'backups'))).toBe(false);
    expect(db.prepare('SELECT value FROM unrelated').get()).toEqual({ value: 'preserve-me' });
  });

  it('does not mutate the database when backup creation fails', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const sessionsDir = join(root, 'aio-sessions');
    const db = createPrivateDatabase(statePath, sessionsDir);

    const result = reconcilePrivateCodexRolloutPaths({
      privateStatePath: statePath,
      sessionsDir,
      backupDir: join(root, 'backups'),
      tempRoots,
      fileExists: presentOnly,
      driverFactory: () => db,
      createBackup: () => { throw new Error('backup unavailable'); },
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'backup-failed' });
    expect(db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get('stale-present')).toEqual({
      rollout_path: '/tmp/codex-browser-mcp-abc/sessions/2026/07/10/rollout-present.jsonl',
    });
  });

  it('rolls back and leaves the database unchanged when the rewrite fails', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const sessionsDir = join(root, 'aio-sessions');
    const db = createPrivateDatabase(statePath, sessionsDir);
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.includes('UPDATE threads')) throw new Error('rewrite boom');
      return originalPrepare(sql);
    };

    const result = reconcilePrivateCodexRolloutPaths({
      privateStatePath: statePath,
      sessionsDir,
      backupDir: join(root, 'backups'),
      tempRoots,
      fileExists: presentOnly,
      driverFactory: () => db,
      createBackup: (_source, backupPath) => writeFileSync(backupPath, 'backup', 'utf-8'),
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'reconcile-failed' });
    db.prepare = originalPrepare;
    expect(db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get('stale-present')).toEqual({
      rollout_path: '/tmp/codex-browser-mcp-abc/sessions/2026/07/10/rollout-present.jsonl',
    });
  });

  it('matches the canonical /private realpath temp root on this platform', () => {
    // Guards against a rollout recorded under the realpath form of the OS temp dir.
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const sessionsDir = join(root, 'aio-sessions');
    const db = createDatabase(statePath);
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL);');
    db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(
      'realpath-home',
      `${sep}private${sep}var${sep}folders${sep}x${sep}T${sep}codex-nomcp-real${sep}sessions${sep}rollout-real.jsonl`,
    );

    const result = reconcilePrivateCodexRolloutPaths({
      privateStatePath: statePath,
      sessionsDir,
      backupDir: join(root, 'backups'),
      tempRoots: ['/private/var/folders/x/T'],
      fileExists: () => true,
      driverFactory: () => db,
      createBackup: (_source, backupPath) => writeFileSync(backupPath, 'backup', 'utf-8'),
    });

    expect(result).toMatchObject({ status: 'reconciled', candidates: 1, rewritten: 1 });
    expect(db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get('realpath-home')).toEqual({
      rollout_path: join(sessionsDir, 'rollout-real.jsonl'),
    });
  });

  it('is wired into application startup after the leaked-thread cleanup', () => {
    const source = readFileSync(join(__dirname, '../../../app/initialization-steps.ts'), 'utf-8');

    expect(source).toContain('reconcilePrivateCodexRolloutPaths');
    expect(source.indexOf('cleanupLeakedAioCodexThreads()')).toBeLessThan(
      source.indexOf('reconcilePrivateCodexRolloutPaths()'),
    );
  });
});
