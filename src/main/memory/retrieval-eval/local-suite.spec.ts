import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSqliteWasmDatabaseWithExport,
  initSqliteWasm,
  openSqliteWasmFileReadOnly,
} from '../../db/sqlite-wasm-driver';
import type { CorpusDoc } from './dataset';
import { FIXTURE_WORKSPACE, seedFixtureCasStore } from './synthetic-suite';
import {
  checkLocalStore,
  discoverLocalStorePaths,
  evaluateLocalCodeQueries,
  resolveActiveUserDataRoot,
  resolveOsAppDataRoot,
  runLocalSuite,
} from './local-suite';

const CODEMEM_EXPECTED_TABLES = ['workspace_root', 'workspace_chunks', 'chunks', 'code_fts'] as const;
const RLM_EXPECTED_TABLES = ['context_stores', 'context_sections', 'rlm_sessions'] as const;

/** Builds a byte-real codemem.sqlite fixture using the REAL production schema (`migrate`) + `CasStore` seeding logic (same helper the synthetic suite uses), then writes it to `destPath`. */
function writeCodememFixture(destPath: string, corpus: readonly CorpusDoc[]): void {
  const { driver, exportBytes } = createSqliteWasmDatabaseWithExport();
  seedFixtureCasStore(driver, corpus);
  writeFileSync(destPath, Buffer.from(exportBytes()));
  driver.close();
}

/** Builds a minimal byte-real rlm.db fixture with the tables `checkLocalStore` looks for. */
function writeRlmFixture(destPath: string): void {
  const { driver, exportBytes } = createSqliteWasmDatabaseWithExport();
  driver.exec(`
    CREATE TABLE context_stores (id TEXT PRIMARY KEY);
    CREATE TABLE context_sections (id TEXT PRIMARY KEY, store_id TEXT);
    CREATE TABLE rlm_sessions (id TEXT PRIMARY KEY);
  `);
  writeFileSync(destPath, Buffer.from(exportBytes()));
  driver.close();
}

/** Builds a fixture file with an unrelated schema (missing every expected table) — the schema-mismatch case. */
function writeSchemaMismatchFixture(destPath: string): void {
  const { driver, exportBytes } = createSqliteWasmDatabaseWithExport();
  driver.exec('CREATE TABLE unrelated_table (x INTEGER)');
  writeFileSync(destPath, Buffer.from(exportBytes()));
  driver.close();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

beforeEach(async () => {
  await initSqliteWasm();
});

describe('discoverLocalStorePaths (pure — never embeds an absolute home-directory path)', () => {
  it('derives both store paths from the injected root via path.join only', () => {
    const injectedRoot = '/injected-root-not-a-real-home-dir';
    const paths = discoverLocalStorePaths(injectedRoot);
    expect(paths).toEqual({
      rlmDbPath: join(injectedRoot, 'rlm', 'rlm.db'),
      codememDbPath: join(injectedRoot, 'codemem.sqlite'),
    });
    // Whatever the real machine's home directory is, it must never leak in —
    // the function only ever joins off the caller-supplied root.
    expect(paths.rlmDbPath.startsWith(injectedRoot)).toBe(true);
    expect(paths.codememDbPath.startsWith(injectedRoot)).toBe(true);
  });

  it('works identically for a second, unrelated injected root (proves no machine-specific state)', () => {
    const a = discoverLocalStorePaths('/root-a');
    const b = discoverLocalStorePaths('/root-b');
    expect(a.rlmDbPath.replace('/root-a', '')).toBe(b.rlmDbPath.replace('/root-b', ''));
    expect(a.codememDbPath.replace('/root-a', '')).toBe(b.codememDbPath.replace('/root-b', ''));
  });
});

describe('resolveOsAppDataRoot (pure — OS default computed from injected deps only)', () => {
  it('never calls the ambient os.homedir(); uses the injected homedir for every platform', () => {
    const fakeHome = '/fake/injected/home';
    expect(resolveOsAppDataRoot({ platform: 'darwin', env: {}, homedir: fakeHome }))
      .toBe(join(fakeHome, 'Library', 'Application Support'));
    expect(resolveOsAppDataRoot({ platform: 'linux', env: {}, homedir: fakeHome }))
      .toBe(join(fakeHome, '.config'));
    expect(resolveOsAppDataRoot({ platform: 'win32', env: {}, homedir: fakeHome }))
      .toBe(join(fakeHome, 'AppData', 'Roaming'));
  });

  it('prefers an explicit env override over the injected homedir', () => {
    expect(resolveOsAppDataRoot({ platform: 'win32', env: { APPDATA: '/env/appdata' }, homedir: '/fake/home' }))
      .toBe('/env/appdata');
    expect(resolveOsAppDataRoot({ platform: 'linux', env: { XDG_CONFIG_HOME: '/env/xdg' }, homedir: '/fake/home' }))
      .toBe('/env/xdg');
  });
});

describe('resolveActiveUserDataRoot (packaged/dev layout selection)', () => {
  it('prefers the packaged ("harness") layout when both exist', () => {
    const appDataRoot = '/injected-app-data';
    const present = new Set([join(appDataRoot, 'harness', 'codemem.sqlite'), join(appDataRoot, 'harness-dev', 'codemem.sqlite')]);
    const root = resolveActiveUserDataRoot({ appDataRoot, env: {}, existsSync: (p) => present.has(p) });
    expect(root).toBe(join(appDataRoot, 'harness'));
  });

  it('falls back to the dev layout when only it exists', () => {
    const appDataRoot = '/injected-app-data';
    const present = new Set([join(appDataRoot, 'harness-dev', 'codemem.sqlite')]);
    const root = resolveActiveUserDataRoot({ appDataRoot, env: {}, existsSync: (p) => present.has(p) });
    expect(root).toBe(join(appDataRoot, 'harness-dev'));
  });

  it('returns undefined when neither layout has a codemem store', () => {
    const root = resolveActiveUserDataRoot({ appDataRoot: '/injected-app-data', env: {}, existsSync: () => false });
    expect(root).toBeUndefined();
  });
});

describe('checkLocalStore — skipped / failed / ok are distinct outcomes', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'local-suite-store-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports "skipped" for a missing store file (not a crash, not a silent no-op)', () => {
    const dbPath = join(root, 'codemem.sqlite');
    const outcome = checkLocalStore('codemem', dbPath, CODEMEM_EXPECTED_TABLES, {
      existsSync,
      openReadOnly: openSqliteWasmFileReadOnly,
    });
    expect(outcome.status).toBe('skipped');
    expect(outcome).toMatchObject({ store: 'codemem', path: dbPath });
  });

  it('reports "failed" for a store with the wrong schema (missing expected tables) — distinct from "skipped"', () => {
    const dbPath = join(root, 'codemem.sqlite');
    writeSchemaMismatchFixture(dbPath);
    const outcome = checkLocalStore('codemem', dbPath, CODEMEM_EXPECTED_TABLES, {
      existsSync,
      openReadOnly: openSqliteWasmFileReadOnly,
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toMatch(/workspace_root/);
    }
  });

  it('reports "failed" for a corrupt (non-SQLite) file — distinct from "skipped"', () => {
    const dbPath = join(root, 'codemem.sqlite');
    writeFileSync(dbPath, 'this is not a sqlite database file, just garbage bytes');
    const outcome = checkLocalStore('codemem', dbPath, CODEMEM_EXPECTED_TABLES, {
      existsSync,
      openReadOnly: openSqliteWasmFileReadOnly,
    });
    expect(outcome.status).toBe('failed');
  });

  it('reports "ok" for a healthy store, opened via a genuinely READ-ONLY connection', () => {
    const dbPath = join(root, 'codemem.sqlite');
    writeCodememFixture(dbPath, [{ id: 'doc-a', type: 'code', text: 'function foo() {}', path: 'src/foo.ts', name: 'foo' }]);
    const outcome = checkLocalStore('codemem', dbPath, CODEMEM_EXPECTED_TABLES, {
      existsSync,
      openReadOnly: openSqliteWasmFileReadOnly,
    });
    expect(outcome.status).toBe('ok');

    // Requirement (a): read-only is enforced by SQLite itself, not merely by
    // caller discipline — attempting a write against the same connection
    // must throw a genuine SQLITE_READONLY error.
    const readOnlyDb = openSqliteWasmFileReadOnly(dbPath);
    expect(() => readOnlyDb.prepare("INSERT INTO chunks (content_hash, ast_normalized_hash, language, chunk_type, name, raw_text) VALUES ('x','x','x','x','x','x')").run())
      .toThrow(/READONLY/i);
    readOnlyDb.close();
  });

  it('checks the RLM store with its own expected-table set and reports "ok" for a healthy fixture', () => {
    const dbPath = join(root, 'rlm.db');
    writeRlmFixture(dbPath);
    const outcome = checkLocalStore('rlm', dbPath, RLM_EXPECTED_TABLES, {
      existsSync,
      openReadOnly: openSqliteWasmFileReadOnly,
    });
    expect(outcome.status).toBe('ok');
  });
});

describe('runLocalSuite — end to end against real fixtures, never mutates anything', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'local-suite-run-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seedHealthyUserData(): { codememPath: string; rlmPath: string } {
    mkdirSync(join(root, 'rlm'), { recursive: true });
    const codememPath = join(root, 'codemem.sqlite');
    const rlmPath = join(root, 'rlm', 'rlm.db');
    writeCodememFixture(codememPath, [
      { id: 'doc-backoff', type: 'code', text: 'exponential backoff retry jitter helper', path: 'src/retry/backoff.ts', name: 'backoff' },
      { id: 'doc-unrelated', type: 'code', text: 'renders a modal dialog component', path: 'src/ui/modal.ts', name: 'modal' },
    ]);
    writeRlmFixture(rlmPath);
    return { codememPath, rlmPath };
  }

  it('runs local code queries against the real read-only codemem store and reports metrics', () => {
    seedHealthyUserData();
    const localQueriesPath = join(root, 'local-queries.jsonl');
    writeFileSync(
      localQueriesPath,
      '{"id":"q-backoff","type":"code","query":"exponential backoff retry","relevant":["src/retry/backoff.ts"]}\n',
    );

    const result = runLocalSuite({
      userDataRoot: root,
      existsSync,
      openReadOnly: openSqliteWasmFileReadOnly,
      readFileSync: (p) => readFileSync(p, 'utf-8'),
      localQueriesPath,
      workspacePath: FIXTURE_WORKSPACE,
    });

    expect(result.rlm.status).toBe('ok');
    expect(result.codemem.status).toBe('ok');
    expect(result.queries.status).toBe('ok');
    if (result.queries.status === 'ok') {
      expect(result.queries.queryCount).toBe(1);
      expect(result.queries.report.queries).toBe(1);
      expect(result.queries.report.r1).toBe(1);
    }
  });

  it('skips query evaluation (but still reports store health) when no local query file exists', () => {
    seedHealthyUserData();
    const result = runLocalSuite({
      userDataRoot: root,
      existsSync,
      openReadOnly: openSqliteWasmFileReadOnly,
      readFileSync: (p) => readFileSync(p, 'utf-8'),
      localQueriesPath: join(root, 'local-queries.jsonl'),
      workspacePath: FIXTURE_WORKSPACE,
    });
    expect(result.rlm.status).toBe('ok');
    expect(result.codemem.status).toBe('ok');
    expect(result.queries.status).toBe('skipped');
  });

  it('reports "skipped" for both stores when the user-data root cannot be found at all', () => {
    const result = runLocalSuite({
      userDataRoot: undefined,
      existsSync,
      openReadOnly: openSqliteWasmFileReadOnly,
      readFileSync: (p) => readFileSync(p, 'utf-8'),
      localQueriesPath: join(root, 'local-queries.jsonl'),
      workspacePath: FIXTURE_WORKSPACE,
    });
    expect(result.rlm.status).toBe('skipped');
    expect(result.codemem.status).toBe('skipped');
    expect(result.queries.status).toBe('skipped');
  });

  it('NEVER writes to the stores or creates any new file in the user-data root', () => {
    const { codememPath, rlmPath } = seedHealthyUserData();
    const localQueriesPath = join(root, 'local-queries.jsonl');
    writeFileSync(
      localQueriesPath,
      '{"id":"q-backoff","type":"code","query":"exponential backoff retry","relevant":["src/retry/backoff.ts"]}\n',
    );

    const before = {
      codememMtime: statSync(codememPath).mtimeMs,
      rlmMtime: statSync(rlmPath).mtimeMs,
      codememHash: sha256(codememPath),
      rlmHash: sha256(rlmPath),
      entries: readdirSync(root, { recursive: true }).sort(),
    };

    const result = runLocalSuite({
      userDataRoot: root,
      existsSync,
      openReadOnly: openSqliteWasmFileReadOnly,
      readFileSync: (p) => readFileSync(p, 'utf-8'),
      localQueriesPath,
      workspacePath: FIXTURE_WORKSPACE,
    });
    expect(result.queries.status).toBe('ok'); // exercise the fullest read path before asserting no writes

    const after = {
      codememMtime: statSync(codememPath).mtimeMs,
      rlmMtime: statSync(rlmPath).mtimeMs,
      codememHash: sha256(codememPath),
      rlmHash: sha256(rlmPath),
      entries: readdirSync(root, { recursive: true }).sort(),
    };

    expect(after.codememMtime).toBe(before.codememMtime);
    expect(after.rlmMtime).toBe(before.rlmMtime);
    expect(after.codememHash).toBe(before.codememHash);
    expect(after.rlmHash).toBe(before.rlmHash);
    expect(after.entries).toEqual(before.entries); // no new files created anywhere under the root
  });
});

describe('evaluateLocalCodeQueries reuses the exact synthetic-suite scoring machinery', () => {
  it('computes recall/NDCG the same way metrics.ts does for the synthetic suite', () => {
    const { driver } = createSqliteWasmDatabaseWithExport();
    seedFixtureCasStore(driver, [
      { id: 'doc-a', type: 'code', text: 'parse jsonl labeled queries dataset', path: 'src/eval/dataset.ts', name: 'parseJsonlQueries' },
    ]);
    const report = evaluateLocalCodeQueries(driver, FIXTURE_WORKSPACE, [
      { id: 'q1', type: 'code', query: 'parse jsonl labeled queries', relevant: ['src/eval/dataset.ts'] },
    ]);
    driver.close();
    expect(report.queries).toBe(1);
    expect(report.r1).toBe(1);
    expect(report.ndcg10).toBe(1);
  });
});
