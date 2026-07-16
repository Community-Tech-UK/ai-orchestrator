import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteWasmDatabase } from '../../../db/sqlite-wasm-driver';
import type { SqliteDriver } from '../../../db/sqlite-driver';
import {
  cleanupLeakedAioCodexThreads,
  mergeAttachedCodexThreads,
  migrateLeakedAioThreadsToPrivateState,
} from './codex-state-cleanup';

describe('cleanupLeakedAioCodexThreads', () => {
  const roots: string[] = [];
  const closeDrivers: (() => void)[] = [];
  const aioTempRoots = ['/tmp', 'C:/Temp'];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    for (const close of closeDrivers.splice(0)) {
      close();
    }
  });

  function makeRoot(): string {
    const root = join(tmpdir(), `codex-state-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
      // The cleanup function owns close(); afterEach releases the shared test driver.
    };
    return db;
  }

  function createCodexStateDatabase(statePath: string): SqliteDriver {
    const db = createDatabase(statePath);
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE thread_dynamic_tools (
        thread_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY(thread_id, position)
      );
      CREATE TABLE agent_job_items (
        job_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        assigned_thread_id TEXT,
        PRIMARY KEY(job_id, item_id)
      );
      CREATE TABLE agent_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );

      INSERT INTO threads (id, rollout_path) VALUES
        ('legitimate', '/Users/example/.codex/sessions/rollout-legitimate.jsonl'),
        ('similar-name', '/tmp/codex-browser-mcpish/sessions/rollout-similar.jsonl'),
        ('browser-leak', '/tmp/codex-browser-mcp-abc/sessions/2026/07/10/rollout-browser.jsonl'),
        ('exec-leak', 'C:\\Temp\\codex-nomcp-def\\sessions\\rollout-exec.jsonl'),
        ('app-server-leak', '/tmp/codex-aio-ghi/sessions/rollout-app-server.jsonl');

      INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES
        ('legitimate', 'browser-leak', 'completed'),
        ('browser-leak', 'exec-leak', 'completed'),
        ('legitimate', 'similar-name', 'completed');

      INSERT INTO thread_dynamic_tools (thread_id, position, name) VALUES
        ('browser-leak', 0, 'browser-tool'),
        ('legitimate', 0, 'legitimate-tool');

      INSERT INTO agent_job_items (job_id, item_id, assigned_thread_id) VALUES
        ('job', 'leaked-assignment', 'app-server-leak'),
        ('job', 'legitimate-assignment', 'legitimate');
      INSERT INTO agent_jobs (id, name) VALUES ('job', 'AIO job');
    `);
    return db;
  }

  it('backs up then removes only AIO-owned thread records and references', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const backupDir = join(root, 'backups');
    const db = createCodexStateDatabase(statePath);
    const lifecycle: string[] = [];

    const result = cleanupLeakedAioCodexThreads({
      statePath,
      backupDir,
      tempRoots: aioTempRoots,
      driverFactory: () => db,
      createBackup: (source, backupPath) => {
        lifecycle.push('backup');
        const row = source.prepare('SELECT COUNT(*) AS count FROM threads').get<{ count: number }>();
        writeFileSync(backupPath, JSON.stringify(row), 'utf-8');
      },
      migrateLeakedThreads: () => {
        lifecycle.push('migrate');
        return 3;
      },
      now: () => 1_752_192_000_000,
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'cleaned',
      migratedThreads: 3,
      removedThreads: 3,
      removedSpawnEdges: 2,
      removedDynamicTools: 1,
      clearedJobAssignments: 1,
    });
    if (result.status !== 'cleaned') throw new Error(`expected a cleaned result, got ${result.status}`);
    expect(result.backupPath).toBe(join(backupDir, 'state_5-before-aio-cleanup-20250711T000000000Z.sqlite'));
    expect(existsSync(result.backupPath)).toBe(true);

    expect(db.prepare('SELECT id FROM threads ORDER BY id').all()).toEqual([
      { id: 'legitimate' },
      { id: 'similar-name' },
    ]);
    expect(db.prepare('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges').all()).toEqual([
      { parent_thread_id: 'legitimate', child_thread_id: 'similar-name' },
    ]);
    expect(db.prepare('SELECT thread_id FROM thread_dynamic_tools').all()).toEqual([
      { thread_id: 'legitimate' },
    ]);
    expect(db.prepare('SELECT item_id, assigned_thread_id FROM agent_job_items ORDER BY item_id').all()).toEqual([
      { item_id: 'leaked-assignment', assigned_thread_id: null },
      { item_id: 'legitimate-assignment', assigned_thread_id: 'legitimate' },
    ]);
    expect(readFileSync(result.backupPath, 'utf-8')).toBe('{"count":5}');
    expect(lifecycle).toEqual(['backup', 'migrate']);
  });

  it('seeds private state with AIO threads and rewrites disposable rollout paths', () => {
    const root = makeRoot();
    const backupPath = join(root, 'backup.sqlite');
    const privateStatePath = join(root, 'private', 'state_5.sqlite');
    mkdirSync(join(root, 'private'), { recursive: true });
    const db = createCodexStateDatabase(privateStatePath);
    db.prepare('INSERT INTO agent_jobs (id, name) VALUES (?, ?)').run('user-job', 'user-only job');
    db.prepare('INSERT INTO agent_job_items (job_id, item_id, assigned_thread_id) VALUES (?, ?, ?)').run(
      'user-job',
      'user-only-item',
      'legitimate',
    );
    rmSync(privateStatePath, { force: true });
    writeFileSync(backupPath, 'consistent-backup-marker', 'utf-8');

    const migrated = migrateLeakedAioThreadsToPrivateState({
      backupPath,
      privateStatePath,
      sessionsDir: join(root, 'aio-sessions'),
      expectedThreads: 3,
      threadIds: ['browser-leak', 'exec-leak', 'app-server-leak'],
      driverFactory: () => db,
    });

    expect(migrated).toBe(3);
    expect(db.prepare('SELECT id, rollout_path FROM threads ORDER BY id').all()).toEqual([
      {
        id: 'app-server-leak',
        rollout_path: join(root, 'aio-sessions', 'rollout-app-server.jsonl'),
      },
      {
        id: 'browser-leak',
        rollout_path: join(root, 'aio-sessions', '2026', '07', '10', 'rollout-browser.jsonl'),
      },
      {
        id: 'exec-leak',
        rollout_path: join(root, 'aio-sessions', 'rollout-exec.jsonl'),
      },
    ]);
    expect(db.prepare('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges').all()).toEqual([
      { parent_thread_id: 'browser-leak', child_thread_id: 'exec-leak' },
    ]);
    expect(db.prepare('SELECT thread_id FROM thread_dynamic_tools').all()).toEqual([
      { thread_id: 'browser-leak' },
    ]);
    expect(db.prepare('SELECT item_id, assigned_thread_id FROM agent_job_items ORDER BY item_id').all()).toEqual([
      { item_id: 'leaked-assignment', assigned_thread_id: 'app-server-leak' },
      { item_id: 'legitimate-assignment', assigned_thread_id: null },
    ]);
    expect(db.prepare('SELECT id FROM agent_jobs ORDER BY id').all()).toEqual([{ id: 'job' }]);
  });

  it('restores an empty private-state placeholder when first migration fails', () => {
    const root = makeRoot();
    const backupPath = join(root, 'backup.sqlite');
    const privateStatePath = join(root, 'private', 'state_5.sqlite');
    mkdirSync(join(root, 'private'), { recursive: true });
    const incompatibleDb = createDatabase(privateStatePath);
    incompatibleDb.exec('CREATE TABLE unrelated (value TEXT)');
    writeFileSync(privateStatePath, '', 'utf-8');
    writeFileSync(backupPath, 'consistent-backup-marker', 'utf-8');

    expect(() => migrateLeakedAioThreadsToPrivateState({
      backupPath,
      privateStatePath,
      sessionsDir: join(root, 'aio-sessions'),
      expectedThreads: 1,
      threadIds: ['missing-thread'],
      driverFactory: () => incompatibleDb,
    })).toThrow('incompatible threads schema');

    expect(readFileSync(privateStatePath, 'utf-8')).toBe('');
    expect(existsSync(`${privateStatePath}-wal`)).toBe(false);
    expect(existsSync(`${privateStatePath}-shm`)).toBe(false);
  });

  it('upserts complete job metadata when migrating into existing private state', () => {
    const root = makeRoot();
    const db = createCodexStateDatabase(join(root, 'private.sqlite'));
    db.prepare('UPDATE agent_jobs SET name = ? WHERE id = ?').run('stale job', 'job');
    db.exec(`
      ATTACH DATABASE ':memory:' AS aio_leak_source;
      CREATE TABLE aio_leak_source.threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL
      );
      CREATE TABLE aio_leak_source.agent_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE aio_leak_source.agent_job_items (
        job_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        assigned_thread_id TEXT,
        PRIMARY KEY(job_id, item_id)
      );
      INSERT INTO aio_leak_source.threads VALUES
        ('browser-leak', '/tmp/codex-browser-mcp-new/sessions/rollout-new.jsonl');
      INSERT INTO aio_leak_source.agent_jobs VALUES ('job', 'fresh job');
      INSERT INTO aio_leak_source.agent_job_items VALUES
        ('job', 'leaked-assignment', 'browser-leak'),
        ('job', 'unassigned-sibling', NULL),
        ('job', 'user-sibling', 'user-only');
    `);

    const migrated = mergeAttachedCodexThreads(db, ['browser-leak']);

    expect(migrated).toBe(1);
    expect(db.prepare('SELECT name FROM agent_jobs WHERE id = ?').get('job')).toEqual({ name: 'fresh job' });
    expect(db.prepare(`
      SELECT item_id, assigned_thread_id
      FROM agent_job_items
      WHERE job_id = ?
      ORDER BY item_id
    `).all('job')).toEqual([
      { item_id: 'leaked-assignment', assigned_thread_id: 'browser-leak' },
      { item_id: 'legitimate-assignment', assigned_thread_id: null },
      { item_id: 'unassigned-sibling', assigned_thread_id: null },
      { item_id: 'user-sibling', assigned_thread_id: null },
    ]);
  });

  it('is idempotent after leaked rows have been removed', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const backupDir = join(root, 'backups');
    const db = createCodexStateDatabase(statePath);
    const options = {
      statePath,
      backupDir,
      tempRoots: aioTempRoots,
      driverFactory: () => db,
      createBackup: (_source: SqliteDriver, backupPath: string) => writeFileSync(backupPath, 'backup', 'utf-8'),
      migrateLeakedThreads: () => 3,
    };
    cleanupLeakedAioCodexThreads(options);

    const result = cleanupLeakedAioCodexThreads(options);

    expect(result).toEqual({ status: 'skipped', reason: 'no-leaked-threads' });
  });

  it('skips a missing Codex state database without creating it', () => {
    const root = makeRoot();
    const statePath = join(root, 'missing.sqlite');

    expect(cleanupLeakedAioCodexThreads({
      statePath,
      backupDir: join(root, 'backups'),
      tempRoots: aioTempRoots,
    })).toEqual({
      status: 'skipped',
      reason: 'missing-database',
    });
    expect(existsSync(statePath)).toBe(false);
  });

  it('skips an incompatible database without backing it up or mutating it', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const backupDir = join(root, 'backups');
    const db = createDatabase(statePath);
    db.exec('CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES (\'preserve-me\');');

    const result = cleanupLeakedAioCodexThreads({
      statePath,
      backupDir,
      tempRoots: aioTempRoots,
      driverFactory: () => db,
    });
    expect(result, JSON.stringify(result)).toEqual({
      status: 'skipped',
      reason: 'incompatible-schema',
    });
    expect(existsSync(backupDir)).toBe(false);

    expect(db.prepare('SELECT value FROM unrelated').get()).toEqual({ value: 'preserve-me' });
  });

  it('does not mutate the database when backup creation fails', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const backupDir = join(root, 'not-a-directory');
    const db = createCodexStateDatabase(statePath);
    writeFileSync(backupDir, 'blocks mkdir', 'utf-8');

    const result = cleanupLeakedAioCodexThreads({
      statePath,
      backupDir,
      tempRoots: aioTempRoots,
      driverFactory: () => db,
      createBackup: () => { throw new Error('backup unavailable'); },
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'backup-failed' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM threads').get()).toEqual({ count: 5 });
  });

  it('does not mutate the user database when private-state migration fails', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const backupDir = join(root, 'backups');
    const db = createCodexStateDatabase(statePath);

    const result = cleanupLeakedAioCodexThreads({
      statePath,
      backupDir,
      tempRoots: aioTempRoots,
      driverFactory: () => db,
      createBackup: (_source, backupPath) => writeFileSync(backupPath, 'backup', 'utf-8'),
      migrateLeakedThreads: () => { throw new Error('private state unavailable'); },
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'migration-failed' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM threads').get()).toEqual({ count: 5 });
  });

  it('does not delete a leaked thread added after the backup snapshot', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const backupDir = join(root, 'backups');
    const db = createCodexStateDatabase(statePath);

    const result = cleanupLeakedAioCodexThreads({
      statePath,
      backupDir,
      tempRoots: aioTempRoots,
      driverFactory: () => db,
      createBackup: (_source, backupPath) => writeFileSync(backupPath, 'backup', 'utf-8'),
      migrateLeakedThreads: () => {
        db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(
          'late-leak',
          '/tmp/codex-aio-late/sessions/rollout-late.jsonl',
        );
        return 3;
      },
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'concurrent-state-change' });
    expect(db.prepare('SELECT id FROM threads WHERE id = ?').get('late-leak')).toEqual({ id: 'late-leak' });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM threads WHERE ${TEST_LEAKED_THREAD_PREDICATE}`).get())
      .toEqual({ count: 4 });
  });

  it('detects a same-count replacement after the backup snapshot', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const backupDir = join(root, 'backups');
    const db = createCodexStateDatabase(statePath);

    const result = cleanupLeakedAioCodexThreads({
      statePath,
      backupDir,
      tempRoots: aioTempRoots,
      driverFactory: () => db,
      createBackup: (_source, backupPath) => writeFileSync(backupPath, 'backup', 'utf-8'),
      migrateLeakedThreads: () => {
        db.prepare('DELETE FROM threads WHERE id = ?').run('browser-leak');
        db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(
          'replacement-leak',
          '/tmp/codex-browser-mcp-replacement/sessions/rollout-replacement.jsonl',
        );
        return 3;
      },
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'concurrent-state-change' });
    expect(db.prepare('SELECT id FROM threads WHERE id = ?').get('replacement-leak'))
      .toEqual({ id: 'replacement-leak' });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM threads WHERE ${TEST_LEAKED_THREAD_PREDICATE}`).get())
      .toEqual({ count: 3 });
  });

  it('detects a same-ID thread update after the backup snapshot', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const backupDir = join(root, 'backups');
    const db = createCodexStateDatabase(statePath);

    const result = cleanupLeakedAioCodexThreads({
      statePath,
      backupDir,
      tempRoots: aioTempRoots,
      driverFactory: () => db,
      createBackup: (_source, backupPath) => writeFileSync(backupPath, 'backup', 'utf-8'),
      migrateLeakedThreads: () => {
        db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(
          '/tmp/codex-browser-mcp-updated/sessions/rollout-updated.jsonl',
          'browser-leak',
        );
        return 3;
      },
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'concurrent-state-change' });
    expect(db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get('browser-leak')).toEqual({
      rollout_path: '/tmp/codex-browser-mcp-updated/sessions/rollout-updated.jsonl',
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM threads WHERE ${TEST_LEAKED_THREAD_PREDICATE}`).get())
      .toEqual({ count: 3 });
  });

  it('detects related job metadata changes after the backup snapshot', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const db = createCodexStateDatabase(statePath);

    const result = cleanupLeakedAioCodexThreads({
      statePath,
      backupDir: join(root, 'backups'),
      tempRoots: aioTempRoots,
      driverFactory: () => db,
      createBackup: (_source, backupPath) => writeFileSync(backupPath, 'backup', 'utf-8'),
      migrateLeakedThreads: () => {
        db.prepare('UPDATE agent_jobs SET name = ? WHERE id = ?').run('updated during migration', 'job');
        return 3;
      },
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'concurrent-state-change' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM threads').get()).toEqual({ count: 5 });
    expect(db.prepare('SELECT name FROM agent_jobs WHERE id = ?').get('job')).toEqual({
      name: 'updated during migration',
    });
  });

  it('preserves legitimate custom Codex homes containing an AIO-like name', () => {
    const root = makeRoot();
    const statePath = join(root, 'state_5.sqlite');
    const backupDir = join(root, 'backups');
    const db = createCodexStateDatabase(statePath);
    const legitimateCustomPath = '/Users/example/codex-aio-personal/sessions/rollout-personal.jsonl';
    db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(
      'legitimate-custom-home',
      legitimateCustomPath,
    );

    const result = cleanupLeakedAioCodexThreads({
      statePath,
      backupDir,
      tempRoots: aioTempRoots,
      driverFactory: () => db,
      createBackup: (_source, backupPath) => writeFileSync(backupPath, 'backup', 'utf-8'),
      migrateLeakedThreads: () => 3,
    });

    expect(result).toMatchObject({ status: 'cleaned', removedThreads: 3 });
    expect(db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get('legitimate-custom-home')).toEqual({
      rollout_path: legitimateCustomPath,
    });
  });

  it('is wired into application startup before stale temp-home cleanup', () => {
    const source = readFileSync(join(__dirname, '../../../app/initialization-steps.ts'), 'utf-8');

    expect(source).toContain('cleanupLeakedAioCodexThreads');
    expect(source.indexOf('cleanupLeakedAioCodexThreads()')).toBeLessThan(
      source.indexOf('sweepStaleCodexTempHomes()'),
    );
  });
});

const TEST_LEAKED_THREAD_PREDICATE = `
  instr(replace(rollout_path, char(92), '/'), '/codex-browser-mcp-') > 0
  OR instr(replace(rollout_path, char(92), '/'), '/codex-nomcp-') > 0
  OR instr(replace(rollout_path, char(92), '/'), '/codex-aio-') > 0
`;
