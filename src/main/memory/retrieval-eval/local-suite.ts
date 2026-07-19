/**
 * WS16 — local-personal retrieval suite (`npm run bench:retrieval -- --local`).
 *
 * Unlike the synthetic suite (which seeds a throwaway in-memory workspace),
 * this suite discovers and reads the OPERATOR's real RLM (`rlm.db`) and
 * codemem (`codemem.sqlite`) SQLite stores under the current Harness
 * user-data layout, opens them READ-ONLY, and — if a local, gitignored query
 * file is present — runs those personally-labeled `code` queries against the
 * real codemem BM25 path (`searchHydratedChunks`, the exact function the
 * production code-retrieval service calls) and reports Recall@k/NDCG@k with
 * the same `metrics.ts` machinery the synthetic suite uses.
 *
 * Guarantees:
 * - Store discovery is pure and root-injectable (`discoverLocalStorePaths`) —
 *   it never embeds an absolute home-directory path; the caller resolves the
 *   real root once (see `resolveOsAppDataRoot` / `resolveActiveUserDataRoot`)
 *   and everything downstream is a `path.join` off that root.
 * - Stores are opened via `openSqliteWasmFileReadOnly` (see
 *   `../../db/sqlite-wasm-driver.ts`), which loads the file's bytes into a
 *   private WASM heap with `SQLITE_DESERIALIZE_READONLY` — a real SQLite
 *   read-only connection, not a lint convention. The suite NEVER opens either
 *   store with a writable driver and NEVER calls `.backup()`/`.exec()` with
 *   DDL/DML against them.
 * - A missing store produces an explicit `skipped` outcome. An opened store
 *   that is missing its expected tables, or throws while being queried,
 *   produces an explicit `failed` outcome — distinct from `skipped`.
 *
 * Local query file: `benchmarks/retrieval/local-queries.jsonl` (gitignored —
 * see `.gitignore`), same JSONL schema as the synthetic queries
 * (`dataset.ts`'s `LabeledQuery`), but `relevant` lists real file paths
 * (relative to `workspacePath`) inside the operator's own indexed repo. This
 * file is never created or written by the suite — only read, if present.
 */

import { join } from 'node:path';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { resolveHarnessUserDataPath } from '../../app/user-data-path';
import { CasStore } from '../../codemem/cas-store';
import { searchHydratedChunks } from '../../codemem/workspace-chunk-search';
import { parseJsonlQueries, type LabeledQuery } from './dataset';
import { buildRetrievalReport, type QueryEvaluation, type RetrievalReport } from './metrics';

export type LocalStoreName = 'rlm' | 'codemem';

export type LocalStoreOutcome =
  | { status: 'skipped'; store: LocalStoreName; path: string; reason: string }
  | { status: 'failed'; store: LocalStoreName; path: string; reason: string }
  | { status: 'ok'; store: LocalStoreName; path: string };

export type LocalQueriesOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'ok'; path: string; report: RetrievalReport; queryCount: number };

export interface LocalSuiteResult {
  userDataRoot: string | undefined;
  rlm: LocalStoreOutcome;
  codemem: LocalStoreOutcome;
  queries: LocalQueriesOutcome;
}

/** Table names `migrate()` guarantees exist in a real `codemem.sqlite`. */
const CODEMEM_EXPECTED_TABLES = ['workspace_root', 'workspace_chunks', 'chunks', 'code_fts'] as const;
/** Table names the RLM schema guarantees exist in a real `rlm.db`. */
const RLM_EXPECTED_TABLES = ['context_stores', 'context_sections', 'rlm_sessions'] as const;

/** File paths for both real stores under a resolved Harness user-data root. Pure — no home-directory lookup. */
export function discoverLocalStorePaths(userDataRoot: string): {
  rlmDbPath: string;
  codememDbPath: string;
} {
  return {
    rlmDbPath: join(userDataRoot, 'rlm', 'rlm.db'),
    codememDbPath: join(userDataRoot, 'codemem.sqlite'),
  };
}

export interface OsAppDataRootDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
}

/**
 * Computes the OS default "application data" root the same way Electron's
 * `app.getPath('appData')` does — without requiring Electron, so this can
 * run under a plain `tsx`/Node CLI script. `homedir` is always caller-passed
 * (typically `os.homedir()`), never hardcoded, so this works for any user.
 */
export function resolveOsAppDataRoot(deps: OsAppDataRootDeps): string {
  if (deps.platform === 'darwin') {
    return join(deps.homedir, 'Library', 'Application Support');
  }
  if (deps.platform === 'win32') {
    return deps.env['APPDATA'] || join(deps.homedir, 'AppData', 'Roaming');
  }
  return deps.env['XDG_CONFIG_HOME'] || join(deps.homedir, '.config');
}

export interface ActiveUserDataRootDeps {
  appDataRoot: string;
  env: Record<string, string | undefined>;
  existsSync: (path: string) => boolean;
}

/**
 * Picks the Harness user-data root actually in use on this machine, reusing
 * `resolveHarnessUserDataPath` (the same helper `src/main/index.ts` uses) for
 * both the packaged (`harness`) and dev (`harness-dev`) layouts. Prefers the
 * packaged layout — an operator's daily-driver install — falling back to the
 * dev layout, and returns `undefined` if neither has a codemem store yet.
 */
export function resolveActiveUserDataRoot(deps: ActiveUserDataRootDeps): string | undefined {
  const candidates = [
    resolveHarnessUserDataPath({ appDataPath: deps.appDataRoot, isPackaged: true, env: deps.env }),
    resolveHarnessUserDataPath({ appDataPath: deps.appDataRoot, isPackaged: false, env: deps.env }),
  ];
  for (const candidate of candidates) {
    const { codememDbPath } = discoverLocalStorePaths(candidate);
    if (deps.existsSync(codememDbPath)) return candidate;
  }
  return undefined;
}

export interface StoreCheckDeps {
  existsSync: (path: string) => boolean;
  openReadOnly: (path: string) => SqliteDriver;
}

/**
 * Opens one store read-only and verifies it is actually queryable: missing
 * file → `skipped`; open failure or missing expected tables → `failed`
 * (schema mismatch / corruption, distinct from "missing"); otherwise `ok`.
 */
export function checkLocalStore(
  store: LocalStoreName,
  dbPath: string,
  expectedTables: readonly string[],
  deps: StoreCheckDeps,
): LocalStoreOutcome {
  if (!deps.existsSync(dbPath)) {
    return { status: 'skipped', store, path: dbPath, reason: `No ${store} database found at ${dbPath}` };
  }
  let db: SqliteDriver | undefined;
  try {
    db = deps.openReadOnly(dbPath);
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[])
        .map((row) => row.name),
    );
    const missing = expectedTables.filter((table) => !tables.has(table));
    if (missing.length > 0) {
      return {
        status: 'failed',
        store,
        path: dbPath,
        reason: `Missing expected table(s) [${missing.join(', ')}] — schema mismatch or corrupt store`,
      };
    }
    // Cheap smoke query (not a full integrity_check — real stores can be
    // multi-GB) that proves the primary table is actually queryable.
    db.prepare(`SELECT 1 FROM ${expectedTables[0]} LIMIT 1`).get();
    return { status: 'ok', store, path: dbPath };
  } catch (error) {
    return {
      status: 'failed',
      store,
      path: dbPath,
      reason: `Unable to query ${store} store: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    db?.close();
  }
}

/** Runs the local `code`-type queries against the real codemem store, reusing the synthetic suite's exact scoring machinery. */
export function evaluateLocalCodeQueries(
  codememDb: SqliteDriver,
  workspacePath: string,
  queries: readonly LabeledQuery[],
  limit = 10,
): RetrievalReport {
  const store = new CasStore(codememDb);
  const evaluations: QueryEvaluation[] = queries
    .filter((query) => query.type === 'code')
    .map((query) => {
      const response = searchHydratedChunks(store, workspacePath, query.query, limit);
      return {
        queryId: query.id,
        type: query.type,
        returned: response.results.map((result) => result.relativePath),
        relevant: new Set(query.relevant),
      };
    });
  return buildRetrievalReport(evaluations);
}

export interface RunLocalSuiteDeps {
  userDataRoot: string | undefined;
  existsSync: (path: string) => boolean;
  openReadOnly: (path: string) => SqliteDriver;
  readFileSync: (path: string) => string;
  localQueriesPath: string;
  workspacePath: string;
}

/** Orchestrates the full local suite: store discovery + health, then (if usable) query evaluation. Never writes anything. */
export function runLocalSuite(deps: RunLocalSuiteDeps): LocalSuiteResult {
  if (!deps.userDataRoot) {
    const reason = 'No Harness user-data directory found (checked the packaged and dev layouts)';
    return {
      userDataRoot: undefined,
      rlm: { status: 'skipped', store: 'rlm', path: '', reason },
      codemem: { status: 'skipped', store: 'codemem', path: '', reason },
      queries: { status: 'skipped', reason: 'Store discovery failed; cannot run local queries' },
    };
  }

  const paths = discoverLocalStorePaths(deps.userDataRoot);
  const rlm = checkLocalStore('rlm', paths.rlmDbPath, RLM_EXPECTED_TABLES, deps);
  const codemem = checkLocalStore('codemem', paths.codememDbPath, CODEMEM_EXPECTED_TABLES, deps);

  if (codemem.status !== 'ok') {
    return {
      userDataRoot: deps.userDataRoot,
      rlm,
      codemem,
      queries: { status: 'skipped', reason: `codemem store is ${codemem.status}; cannot run local queries` },
    };
  }

  if (!deps.existsSync(deps.localQueriesPath)) {
    return {
      userDataRoot: deps.userDataRoot,
      rlm,
      codemem,
      queries: {
        status: 'skipped',
        reason: `No local query file at ${deps.localQueriesPath} — see docs/testing.md (WS16) to create one`,
      },
    };
  }

  const allQueries = parseJsonlQueries(deps.readFileSync(deps.localQueriesPath));
  const codeQueries = allQueries.filter((query) => query.type === 'code');
  if (codeQueries.length === 0) {
    return {
      userDataRoot: deps.userDataRoot,
      rlm,
      codemem,
      queries: { status: 'skipped', reason: `${deps.localQueriesPath} has no type:"code" queries` },
    };
  }

  const db = deps.openReadOnly(paths.codememDbPath);
  try {
    const report = evaluateLocalCodeQueries(db, deps.workspacePath, codeQueries);
    return {
      userDataRoot: deps.userDataRoot,
      rlm,
      codemem,
      queries: { status: 'ok', path: deps.localQueriesPath, report, queryCount: codeQueries.length },
    };
  } finally {
    db.close();
  }
}
