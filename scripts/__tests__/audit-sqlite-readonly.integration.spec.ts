import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const modules = [
  ['codex-helper-trial-report.mjs', 'AIO_CODEX_HELPERS_SQLITE_DRIVER'],
  ['context-ceiling-replay.mjs', 'AIO_CONTEXT_REPLAY_SQLITE_DRIVER'],
] as const;
let root: string;
let healthy: string;
let hot: string;
let nextFixture = 0;
const script = (name: string) => join(process.cwd(), 'scripts', name);
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function snapshot(database: string) {
  return { database: hash(database), journal: existsSync(`${database}-journal`) ? hash(`${database}-journal`) : null };
}
function fixture(condition: 'healthy' | 'hot') {
  const directory = join(root, `read-${nextFixture++}`);
  mkdirSync(directory);
  const database = join(directory, 'source.db');
  copyFileSync(condition === 'healthy' ? healthy : hot, database);
  if (condition === 'hot') copyFileSync(`${hot}-journal`, `${database}-journal`);
  return { directory, database };
}
function driverEnv(key: string, driver: 'cli' | 'default') {
  const env = { ...process.env };
  if (driver === 'cli') env[key] = 'cli'; else delete env[key];
  return env;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audit-readonly-'));
  healthy = join(root, 'healthy.db'); hot = join(root, 'hot.db');
  // plan_queue_items carries the RUNTIME schema, taken from loop-schema.ts's
  // own migration SQL rather than a hand-kept copy: the audit CLI selects id,
  // state, landed_commit, created_at and updated_at (its landing cutoff reads
  // updated_at), so the fixture must hold the columns the app actually
  // creates. The row stays inert: one landed item with no logged worker.
  const schemaSource = readFileSync(join(process.cwd(), 'src', 'main', 'orchestration', 'loop-schema.ts'), 'utf8');
  const migrationSql = [...schemaSource.matchAll(/up: `([\s\S]*?)`/g)].map((match) => match[1]).join('\n');
  expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS plan_queue_items');
  execFileSync('sqlite3', [healthy, `PRAGMA journal_mode=DELETE;
    CREATE TABLE example(id INTEGER PRIMARY KEY, value TEXT);
    WITH RECURSIVE rows(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM rows WHERE id<200)
    INSERT INTO example SELECT id, 'original'||hex(zeroblob(2000)) FROM rows;
    ${migrationSql}
    INSERT INTO plan_queue_items
      (id, run_id, document_path, state, landed_commit, created_at, updated_at)
      VALUES ('inert-item', 'inert-run', '/repo/docs/plans/inert_plan.md', 'landed', 'inert-commit', 1, 2);`]);
  copyFileSync(healthy, hot);
  // Keep stdin open, then kill only this transaction writer after dirty pages spill.
  // Its intentional SIGKILL is separate from the test runner's actual exit status.
  const writer = spawn('sqlite3', [hot]);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    writer.once('error', reject);
    writer.once('close', (code, signal) => resolve({ code, signal }));
  });
  let output = ''; let writerErrors = '';
  writer.stderr.on('data', chunk => { writerErrors += String(chunk); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { writer.kill('SIGKILL'); reject(new Error('Disposable transaction writer did not become ready')); }, 5000);
      writer.once('error', error => { clearTimeout(timeout); reject(error); });
      writer.once('exit', () => { clearTimeout(timeout); if (!output.includes('INERT_HOT_READY')) reject(new Error('Disposable transaction writer exited before readiness')); });
      writer.stdout.on('data', chunk => {
        output += String(chunk);
        if (output.includes('INERT_HOT_READY')) { clearTimeout(timeout); resolve(); }
      });
      writer.stdin.once('error', error => { clearTimeout(timeout); reject(error); });
      writer.stdin.write("PRAGMA cache_size=5; PRAGMA cache_spill=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; UPDATE example SET value='changed'||substr(value,8);\n.print INERT_HOT_READY\n");
    });
  } finally {
    writer.kill('SIGKILL');
    const result = await closed;
    expect(result).toEqual({ code: null, signal: 'SIGKILL' });
    if (process.env['AIO_AUDIT_READONLY_TEST_RECEIPTS']) appendFileSync(process.env['AIO_AUDIT_READONLY_TEST_RECEIPTS'], JSON.stringify({ kind: 'intentional-disposable-transaction-crash', pid: writer.pid, ...result, closed: new Date().toISOString() }) + '\n');
  }
  expect(writerErrors).toBe('');
  expect(snapshot(hot).journal).not.toBeNull();
  expect(hash(hot)).not.toBe(hash(healthy));
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('audit SQLite reads preserve database and rollback journal bytes', () => {
  for (const [name, key] of modules) {
    for (const driver of ['cli', 'default'] as const) {
      it.each(['healthy', 'hot'] as const)(`${name}, ${driver}: %s read stays read-only`, condition => {
        const { database } = fixture(condition);
        const before = snapshot(database);
        const query = 'SELECT substr(value,1,8) AS value, ? AS quoted FROM example WHERE id = ?';
        const source = `import {queryRows} from ${JSON.stringify(pathToFileURL(script(name)).href)}; console.log(JSON.stringify(queryRows(process.argv[1], ${JSON.stringify(query)}, ["it's an inert quote", 1])));`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, database], { encoding: 'utf8', env: driverEnv(key, driver) });
        expect(result.status, result.stderr).toBe(0); expect(result.signal).toBeNull();
        expect(snapshot(database)).toEqual(before);
        expect(JSON.parse(result.stdout)).toEqual(condition === 'hot' ? null : [{ value: 'original', quoted: "it's an inert quote" }]);
      });
    }
  }
  for (const driver of ['cli', 'default'] as const) {
    it.each(['healthy', 'hot'] as const)(`actual Claude --subagents CLI, ${driver}: %s preserves its input`, condition => {
      const { directory, database } = fixture(condition);
      for (const name of ['userdata', 'projects', 'policy']) mkdirSync(join(directory, name));
      const before = snapshot(database);
      const result = spawnSync(process.execPath, [script('claude-cost-audit-report.mjs'), '--subagents', '--userdata', join(directory, 'userdata'), '--projects', join(directory, 'projects'), '--policy-dir', join(directory, 'policy'), '--loop-db', database], {
        encoding: 'utf8', env: { ...driverEnv('AIO_COST_AUDIT_SQLITE_DRIVER', driver), AIO_COST_ATTRIBUTION_DIR: join(directory, 'userdata', 'cost-attribution') },
      });
      expect(result.status, result.stderr).toBe(0); expect(result.signal).toBeNull();
      expect(snapshot(database)).toEqual(before);
      expect(result.stdout).toContain(`Unassigned (no logged worker): ${condition === 'hot' ? 0 : 1}.`);
      expect(result.stdout).toContain('pending (no data)');
      if (condition === 'hot') expect(result.stderr).toContain('readonly');
    });
  }
  it('the paired SQLite engine read-only control refuses hot-journal recovery', () => {
    const { database } = fixture('hot'); const before = snapshot(database);
    const result = spawnSync('sqlite3', ['-readonly', '-json', database, 'SELECT value FROM example LIMIT 1'], { encoding: 'utf8' });
    // The refusal's exit number varies by sqlite3 build (1 on macOS, 8 on Linux).
    expect(result.status).toBeGreaterThan(0); expect(result.signal).toBeNull();
    expect(result.stderr).toContain('readonly'); expect(snapshot(database)).toEqual(before);
  });
});
