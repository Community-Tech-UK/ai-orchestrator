import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import { parseJsonlDocs, parseJsonlQueries, splitQueries, validateDataset } from './dataset';
import { runSyntheticSuite } from './synthetic-suite';
import { compareToBaseline, type RetrievalReport } from './metrics';

const BENCH_ROOT = join(__dirname, '../../../../benchmarks/retrieval');
const FIXTURES = join(BENCH_ROOT, 'fixtures');

function loadFixtureDataset() {
  return {
    corpus: parseJsonlDocs(readFileSync(join(FIXTURES, 'corpus.jsonl'), 'utf-8')),
    queries: parseJsonlQueries(readFileSync(join(FIXTURES, 'queries.jsonl'), 'utf-8')),
  };
}

describe('retrieval dataset fixtures', () => {
  it('parse, cross-validate, and split deterministically', () => {
    const dataset = loadFixtureDataset();
    expect(dataset.corpus.length).toBeGreaterThanOrEqual(12);
    expect(dataset.queries.length).toBeGreaterThanOrEqual(10);
    expect(validateDataset(dataset)).toEqual([]);

    const first = splitQueries(dataset.queries);
    const second = splitQueries([...dataset.queries].reverse());
    // Same membership regardless of input order.
    expect(new Set(first.dev.map((q) => q.id))).toEqual(new Set(second.dev.map((q) => q.id)));
    expect(first.dev.length + first.heldOut.length).toBe(dataset.queries.length);
    expect(first.heldOut.length).toBeGreaterThan(0);
  });

  it('rejects malformed rows and dangling relevant ids', () => {
    expect(() => parseJsonlQueries('{"id":"q","type":"code","query":"x","relevant":[]}')).toThrow(/relevant/);
    expect(() => parseJsonlDocs('{"id":"d","type":"nope","text":"x"}')).toThrow(/unknown type/);
    const dataset = loadFixtureDataset();
    dataset.queries[0] = { ...dataset.queries[0], relevant: ['ghost-doc'] };
    expect(validateDataset(dataset).join('\n')).toContain('ghost-doc');
  });
});

describe('runSyntheticSuite (real codemem BM25 + lesson digest)', () => {
  it('reproduces the committed baseline (no regression against the real engines)', () => {
    const baseline = JSON.parse(
      readFileSync(join(BENCH_ROOT, 'baseline.json'), 'utf-8'),
    ) as { all: RetrievalReport };
    const result = runSyntheticSuite(loadFixtureDataset(), defaultDriverFactory);

    // The committed baseline was generated from these same real engines. A
    // regression here means the ENGINE (codemem BM25 or lesson digest ranking)
    // changed — exactly what the harness exists to catch. Improvements pass
    // (and should be locked in by regenerating baseline.json).
    const verdict = compareToBaseline(result.all, baseline.all);
    expect(verdict.regressions).toEqual([]);
    expect(verdict.ok).toBe(true);

    // Sanity floors so a silently-empty engine can't "pass" a zeroed baseline.
    expect(result.all.perType['code'].r5).toBeGreaterThanOrEqual(0.9);
    expect(result.all.perType['lesson'].r5).toBeGreaterThanOrEqual(0.9);
    // Split reports cover every query exactly once.
    expect(result.dev.queries + result.heldOut.queries).toBe(result.all.queries);
  });

  it('is deterministic across runs', () => {
    const dataset = loadFixtureDataset();
    const a = runSyntheticSuite(dataset, defaultDriverFactory);
    const b = runSyntheticSuite(dataset, defaultDriverFactory);
    expect(a).toEqual(b);
  });
});
