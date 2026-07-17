/**
 * WS16 — retrieval evaluation runner (`npm run bench:retrieval`).
 *
 * Runs the synthetic suite against the REAL codemem BM25 + lesson-digest
 * engines over the committed fixture dataset, prints R@1/5/10 + NDCG@10 with a
 * per-type breakdown and a dev/held-out split, and compares against the
 * committed baseline (`benchmarks/retrieval/baseline.json`).
 *
 * Flags:
 *   --update-baseline   overwrite baseline.json with this run (lock in a win)
 *   --local             also run the local-personal suite against James's real
 *                       RLM/codemem stores (READ-ONLY; results never committed).
 *
 * Exit code 1 on a regression vs. baseline so CI/`test:slow` can gate.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSqliteWasmDatabase, initSqliteWasm } from '../src/main/db/sqlite-wasm-driver';
import { parseJsonlDocs, parseJsonlQueries } from '../src/main/memory/retrieval-eval/dataset';
import { runSyntheticSuite } from '../src/main/memory/retrieval-eval/synthetic-suite';
import { compareToBaseline, type MetricSummary, type RetrievalReport } from '../src/main/memory/retrieval-eval/metrics';

const BENCH_ROOT = join(__dirname, '../benchmarks/retrieval');
const FIXTURES = join(BENCH_ROOT, 'fixtures');
const BASELINE_PATH = join(BENCH_ROOT, 'baseline.json');

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

async function main(): Promise<void> {
  await initSqliteWasm();
  const args = new Set(process.argv.slice(2));
  const dataset = {
    corpus: parseJsonlDocs(readFileSync(join(FIXTURES, 'corpus.jsonl'), 'utf-8')),
    queries: parseJsonlQueries(readFileSync(join(FIXTURES, 'queries.jsonl'), 'utf-8')),
  };

  console.log('WS16 retrieval evaluation — synthetic suite (fixture corpus)');
  const result = runSyntheticSuite(dataset, createSqliteWasmDatabase);
  printReport('ALL', result.all);
  printReport('dev', result.dev);
  printReport('held-out', result.heldOut);

  if (args.has('--update-baseline')) {
    writeFileSync(BASELINE_PATH, JSON.stringify(result, null, 2) + '\n');
    console.log(`\nBaseline updated: ${BASELINE_PATH}`);
    return;
  }

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

  if (args.has('--local')) {
    console.log(
      '\n[--local] The local-personal suite runs against your real RLM/codemem ' +
      'stores READ-ONLY and is never committed. Not yet wired to a live store in ' +
      'this runner; see docs/testing.md (WS16) for the manual procedure.',
    );
  }
}

void main();
