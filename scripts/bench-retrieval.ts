/**
 * WS16 — retrieval evaluation runner (`npm run bench:retrieval`).
 *
 * Runs the synthetic suite against the REAL codemem BM25 + lesson-digest
 * engines over the committed fixture dataset, prints R@1/5/10 + NDCG@10 with a
 * per-type breakdown and a dev/held-out split, and compares against the
 * committed baseline (`benchmarks/retrieval/baseline.json`).
 *
 * Flags:
 *   --update-baseline        overwrite baseline.json with this run (lock in a win) —
 *                            always the committed SYNTHETIC suite/baseline only.
 *   --local                  also run the local-personal suite against the operator's
 *                            real RLM/codemem stores (READ-ONLY; results never
 *                            committed — see docs/testing.md WS16).
 *   --local-workspace=<path> workspace to run local `code` queries against
 *                            (defaults to this repo checkout).
 *   --local-user-data=<path> override discovery and point --local at this
 *                            user-data root instead (e.g. a specific
 *                            instance's directory, or a throwaway fixture
 *                            directory for manual verification).
 *   --local-force-wasm       keep --local on the in-process WASM read-only
 *                            driver (2 GiB store ceiling) instead of the
 *                            native Electron-as-Node child.
 *
 * Exit code 1 on a regression vs. baseline so CI/`test:slow` can gate.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqliteDriver } from '../src/main/db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm, openSqliteWasmFileReadOnly } from '../src/main/db/sqlite-wasm-driver';
import { parseJsonlDocs, parseJsonlQueries } from '../src/main/memory/retrieval-eval/dataset';
import { runSyntheticSuite } from '../src/main/memory/retrieval-eval/synthetic-suite';
import { compareToBaseline, type MetricSummary, type RetrievalReport } from '../src/main/memory/retrieval-eval/metrics';
import {
  resolveOsAppDataRoot,
  resolveActiveUserDataRoot,
  runLocalSuite,
  type LocalStoreOutcome,
  type LocalSuiteResult,
} from '../src/main/memory/retrieval-eval/local-suite';
import {
  LOCAL_CHILD_FLAG,
  buildLocalChildArgs,
  formatLocalChildResult,
  parseLocalChildStdout,
  planLocalDriver,
  resolveElectronBinaryPath,
} from '../src/main/memory/retrieval-eval/local-suite-driver';

const BENCH_ROOT = join(__dirname, '../benchmarks/retrieval');
const FIXTURES = join(BENCH_ROOT, 'fixtures');
const BASELINE_PATH = join(BENCH_ROOT, 'baseline.json');
const LOCAL_QUERIES_PATH = join(BENCH_ROOT, 'local-queries.jsonl');
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT_PATH = join(__dirname, 'bench-retrieval.ts');
const TSX_CLI_PATH = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function fmt(summary: MetricSummary): string {
  return `R@1=${summary.r1.toFixed(3)} R@5=${summary.r5.toFixed(3)} ` +
    `R@10=${summary.r10.toFixed(3)} NDCG@10=${summary.ndcg10.toFixed(3)} (n=${summary.queries})`;
}

function printReport(label: string, report: RetrievalReport): void {
  console.log(`\n${label}: ${fmt(report)}`);
  for (const [type, summary] of Object.entries(report.perType)) {
    console.log(`  ${type.padEnd(8)} ${fmt(summary)}`);
  }
}

function printStoreOutcome(outcome: LocalStoreOutcome): void {
  if (outcome.status === 'ok') {
    console.log(`  ${outcome.store.padEnd(8)} ok       ${outcome.path}`);
  } else {
    console.log(`  ${outcome.store.padEnd(8)} ${outcome.status.padEnd(8)} ${outcome.reason}`);
  }
}

function parseArgValue(args: readonly string[], prefix: string): string | undefined {
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function parseLocalWorkspaceArg(args: readonly string[]): string {
  const value = parseArgValue(args, '--local-workspace=');
  return value ? resolve(value) : REPO_ROOT;
}

export interface BenchActions {
  /** Overwrite the committed SYNTHETIC baseline with this run. */
  updateBaseline: boolean;
  /** Compare this run's synthetic result against the committed baseline. */
  checkRegression: boolean;
  /** Also run the local-personal suite against real stores (never when updating the baseline). */
  runLocal: boolean;
}

/**
 * Single source of truth for what a given CLI invocation does. `main()`
 * switches on this instead of inlining `args.has(...)` checks so the
 * "`--update-baseline` never runs the local suite, even combined with
 * `--local`" contract is one pure, directly-testable function rather than
 * duplicated/mirrored branching.
 */
export function planBenchActions(args: ReadonlySet<string>): BenchActions {
  if (args.has('--update-baseline')) {
    return { updateBaseline: true, checkRegression: false, runLocal: false };
  }
  return { updateBaseline: false, checkRegression: true, runLocal: args.has('--local') };
}

/** Runs the local suite in this process with the given read-only driver. */
function computeLocalResult(args: readonly string[], openReadOnly: (path: string) => SqliteDriver): LocalSuiteResult {
  const userDataOverride = parseArgValue(args, '--local-user-data=');
  const userDataRoot = userDataOverride
    ? resolve(userDataOverride)
    : resolveActiveUserDataRoot({
      appDataRoot: resolveOsAppDataRoot({ platform: process.platform, env: process.env, homedir: homedir() }),
      env: process.env,
      existsSync,
    });
  return runLocalSuite({
    userDataRoot,
    existsSync,
    openReadOnly,
    readFileSync: (path) => readFileSync(path, 'utf-8'),
    localQueriesPath: LOCAL_QUERIES_PATH,
    workspacePath: parseLocalWorkspaceArg(args),
  });
}

/**
 * Re-runs the local suite inside a short-lived `ELECTRON_RUN_AS_NODE=1` child,
 * where the native (ABI-matched, no 2 GiB ceiling) read-only driver loads.
 * Throws on any spawn/exit/protocol failure so the caller can fall back
 * loudly rather than silently reporting a store as unreadable.
 */
function runLocalInNativeChild(args: readonly string[], electronBinaryPath: string): LocalSuiteResult {
  const child = spawnSync(
    electronBinaryPath,
    buildLocalChildArgs(TSX_CLI_PATH, SCRIPT_PATH, args),
    {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`Local-suite child exited with status ${child.status}: ${(child.stderr || '').trim() || '(no stderr)'}`);
  }
  return parseLocalChildStdout(child.stdout ?? '');
}

/** Child-process entry point: native driver, JSON result on stdout, nothing else run. */
async function runLocalChild(args: readonly string[]): Promise<void> {
  const { defaultDriverFactory } = await import('../src/main/db/better-sqlite3-driver');
  const result = computeLocalResult(args, (path) => defaultDriverFactory(path, { readonly: true }));
  process.stdout.write(`${formatLocalChildResult(result)}\n`);
}

async function runLocal(args: readonly string[]): Promise<void> {
  console.log('\n[--local] local-personal suite (READ-ONLY, never committed)');
  const electronBinaryPath = resolveElectronBinaryPath({
    repoRoot: REPO_ROOT,
    existsSync,
    readFileSync: (path) => readFileSync(path, 'utf-8'),
  });
  const plan = planLocalDriver({ args: new Set(args), electronBinaryPath });
  console.log(`  driver: ${plan.mode} — ${plan.reason}`);

  let result: LocalSuiteResult;
  if (plan.mode === 'native-child' && electronBinaryPath) {
    try {
      result = runLocalInNativeChild(args, electronBinaryPath);
    } catch (error) {
      console.warn(`  ⚠️  native child failed (${error instanceof Error ? error.message : String(error)});`);
      console.warn('      falling back to the in-process WASM driver — stores above 2 GiB will report failed.');
      await initSqliteWasm();
      result = computeLocalResult(args, openSqliteWasmFileReadOnly);
    }
  } else {
    await initSqliteWasm();
    result = computeLocalResult(args, openSqliteWasmFileReadOnly);
  }

  console.log(`  user-data root: ${result.userDataRoot ?? '(not found)'}`);
  printStoreOutcome(result.rlm);
  printStoreOutcome(result.codemem);

  if (result.queries.status === 'skipped') {
    console.log(`  queries  skipped  ${result.queries.reason}`);
    return;
  }
  console.log(`  queries  ok       ${result.queries.queryCount} local quer${result.queries.queryCount === 1 ? 'y' : 'ies'} from ${result.queries.path}`);
  printReport('local', result.queries.report);
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes(LOCAL_CHILD_FLAG)) {
    // Spawned by runLocalInNativeChild: run only the local suite, natively.
    await runLocalChild(argv);
    return;
  }

  await initSqliteWasm();
  const args = new Set(argv);
  const actions = planBenchActions(args);
  const dataset = {
    corpus: parseJsonlDocs(readFileSync(join(FIXTURES, 'corpus.jsonl'), 'utf-8')),
    queries: parseJsonlQueries(readFileSync(join(FIXTURES, 'queries.jsonl'), 'utf-8')),
  };

  console.log('WS16 retrieval evaluation — synthetic suite (fixture corpus)');
  const result = runSyntheticSuite(dataset, createSqliteWasmDatabase);
  printReport('ALL', result.all);
  printReport('dev', result.dev);
  printReport('held-out', result.heldOut);

  if (actions.updateBaseline) {
    writeFileSync(BASELINE_PATH, JSON.stringify(result, null, 2) + '\n');
    console.log(`\nBaseline updated: ${BASELINE_PATH}`);
    return;
  }

  if (actions.checkRegression) {
    if (!existsSync(BASELINE_PATH)) {
      console.error(`\nNo baseline at ${BASELINE_PATH}. Run with --update-baseline to create one.`);
      process.exitCode = 1;
      return;
    }

    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as { all: RetrievalReport };
    const verdict = compareToBaseline(result.all, baseline.all);
    if (verdict.ok) {
      console.log('\n✅ No regression vs. committed baseline.');
    } else {
      console.error('\n❌ Regression vs. committed baseline:');
      for (const line of verdict.regressions) console.error(`  - ${line}`);
      process.exitCode = 1;
    }
  }

  if (actions.runLocal) {
    await runLocal(argv);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
