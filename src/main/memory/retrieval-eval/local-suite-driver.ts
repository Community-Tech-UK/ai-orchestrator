/**
 * WS16 — how `npm run bench:retrieval -- --local` obtains a READ-ONLY
 * connection to the operator's real (multi-gigabyte) stores.
 *
 * The suite itself (`local-suite.ts`) is driver-agnostic: it takes an injected
 * `openReadOnly(path) => SqliteDriver`. This module decides *which* read-only
 * driver that is, and why.
 *
 * Background: the first implementation always used
 * `openSqliteWasmFileReadOnly`, which loads the whole file into a private WASM
 * heap via `sqlite3_deserialize(..., SQLITE_DESERIALIZE_READONLY)`. That is a
 * genuine engine-level read-only connection, but the WASM build is 32-bit, so
 * it caps out at 2 GiB — and a daily-driver `codemem.sqlite` / `rlm.db` is
 * comfortably larger than that, which made the documented `--local` run report
 * `failed` on exactly the stores it exists to measure.
 *
 * The native `better-sqlite3` addon has no such ceiling and opens the file
 * in-place (`SQLITE_OPEN_READONLY`, no whole-file read), but it is built for
 * Electron's ABI and cannot be loaded by the plain-Node/`tsx` process that runs
 * this benchmark. The fix is therefore a runtime choice, not a new SQLite
 * layer: re-run the local suite in a short-lived `ELECTRON_RUN_AS_NODE=1`
 * child, where that addon loads correctly, and hand its result back as JSON.
 *
 * Everything here is pure and dependency-injected so the decision, the child
 * command line, and the result hand-off are unit-testable without spawning
 * anything.
 */

import { join } from 'node:path';
import type { LocalSuiteResult } from './local-suite';

/** Marks the process as the short-lived Electron-as-Node child that runs the local suite natively. */
export const LOCAL_CHILD_FLAG = '--local-child';
/** Escape hatch: stay in-process on the WASM driver (2 GiB ceiling applies). */
export const LOCAL_FORCE_WASM_FLAG = '--local-force-wasm';
/** Line prefix the child writes its JSON result on, so ordinary logging can share stdout. */
export const LOCAL_RESULT_SENTINEL = '__WS16_LOCAL_SUITE_JSON__ ';

export type LocalDriverMode =
  /** Parent: delegate the whole local suite to an Electron-as-Node child using the native addon. */
  | 'native-child'
  /** Child: run it here, natively, and emit JSON. */
  | 'native-in-process'
  /** No Electron available (or explicitly forced): WASM driver, 2 GiB ceiling. */
  | 'wasm-in-process';

export interface LocalDriverPlan {
  mode: LocalDriverMode;
  reason: string;
}

export interface LocalDriverPlanDeps {
  args: ReadonlySet<string>;
  electronBinaryPath: string | undefined;
}

/** Single source of truth for which read-only driver a given `--local` invocation uses. */
export function planLocalDriver(deps: LocalDriverPlanDeps): LocalDriverPlan {
  if (deps.args.has(LOCAL_CHILD_FLAG)) {
    return {
      mode: 'native-in-process',
      reason: 'running as the Electron-as-Node child; native better-sqlite3 read-only connection',
    };
  }
  if (deps.args.has(LOCAL_FORCE_WASM_FLAG)) {
    return {
      mode: 'wasm-in-process',
      reason: `${LOCAL_FORCE_WASM_FLAG} requested — WASM read-only driver (stores above 2 GiB will report failed)`,
    };
  }
  if (!deps.electronBinaryPath) {
    return {
      mode: 'wasm-in-process',
      reason: 'no local Electron binary found — falling back to the WASM read-only driver (2 GiB ceiling)',
    };
  }
  return {
    mode: 'native-child',
    reason: 'delegating to an Electron-as-Node child so the native read-only driver can open stores above 2 GiB',
  };
}

export interface ElectronBinaryDeps {
  repoRoot: string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
}

/**
 * Resolves the installed Electron executable the same way the `electron` npm
 * package does (`dist/` + the platform path recorded in `path.txt`), without
 * importing `electron` — this file is loaded by a plain-Node script and by
 * Vitest, where that import resolves differently.
 */
export function resolveElectronBinaryPath(deps: ElectronBinaryDeps): string | undefined {
  const pathFile = join(deps.repoRoot, 'node_modules', 'electron', 'path.txt');
  if (!deps.existsSync(pathFile)) return undefined;
  const relative = deps.readFileSync(pathFile).trim();
  if (!relative) return undefined;
  const binary = join(deps.repoRoot, 'node_modules', 'electron', 'dist', relative);
  return deps.existsSync(binary) ? binary : undefined;
}

/**
 * Argv for the child: the tsx CLI, this script, the original flags, and the
 * child marker exactly once (so a stray `--local-child` in the parent's own
 * argv can never produce a duplicate or an infinite delegation loop).
 */
export function buildLocalChildArgs(
  tsxCliPath: string,
  scriptPath: string,
  args: readonly string[],
): string[] {
  return [tsxCliPath, scriptPath, ...args.filter((arg) => arg !== LOCAL_CHILD_FLAG), LOCAL_CHILD_FLAG];
}

/** Serializes the child's result onto a single sentinel-prefixed stdout line. */
export function formatLocalChildResult(result: LocalSuiteResult): string {
  return `${LOCAL_RESULT_SENTINEL}${JSON.stringify(result)}`;
}

/** Reads the child's result back, failing loudly (with context) rather than silently reporting an empty run. */
export function parseLocalChildStdout(stdout: string): LocalSuiteResult {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(LOCAL_RESULT_SENTINEL));
  if (!line) {
    throw new Error(
      `Local-suite child produced no ${LOCAL_RESULT_SENTINEL.trim()} line. Raw output: ${stdout.trim() || '(empty)'}`,
    );
  }
  return JSON.parse(line.slice(LOCAL_RESULT_SENTINEL.length)) as LocalSuiteResult;
}
