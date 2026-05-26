/**
 * FU-5 unit tests for the loop invoker's iteration-output parsers.
 *
 * These cover the parser plumbing that lets `LoopChildResult` carry real
 * `testPassCount` / `testFailCount` / `errors` numbers instead of the
 * hardcoded null/[] placeholders the invoker used to emit. The progress
 * detector's D / D-prime / E signals depend on these values to fire
 * accurately.
 */

import { describe, expect, it } from 'vitest';
import { parseTestCounts, classifyIterationErrors } from './default-invokers';

describe('parseTestCounts', () => {
  it('returns null/null for empty output', () => {
    expect(parseTestCounts('')).toEqual({ pass: null, fail: null });
  });

  it('returns null/null when no recognised runner summary appears', () => {
    expect(parseTestCounts('just some prose with no test summary anywhere')).toEqual({ pass: null, fail: null });
  });

  it('parses jest-style "Tests: N failed, N skipped, N passed, N total"', () => {
    const out = 'Test Suites: 1 passed, 1 total\nTests:       2 failed, 3 skipped, 10 passed, 15 total\n';
    expect(parseTestCounts(out)).toEqual({ pass: 10, fail: 2 });
  });

  it('parses jest summary with no failures', () => {
    const out = 'Tests:       12 passed, 12 total';
    expect(parseTestCounts(out)).toEqual({ pass: 12, fail: 0 });
  });

  it('parses jest failed-only summaries', () => {
    const out = 'Tests:       2 failed, 2 total';
    expect(parseTestCounts(out)).toEqual({ pass: 0, fail: 2 });
  });

  it('parses vitest "Tests   N passed | N failed" pipe form', () => {
    const out = ' Test Files  3 passed (3)\n      Tests   10 passed | 2 failed (12)';
    expect(parseTestCounts(out)).toEqual({ pass: 10, fail: 2 });
  });

  it('parses vitest failed-only summary lines', () => {
    const out = ' Test Files  1 failed (1)\n      Tests  2 failed (2)';
    expect(parseTestCounts(out)).toEqual({ pass: 0, fail: 2 });
  });

  it('parses vitest "Tests  N passed (N)" — pass-only form', () => {
    const out = ' Test Files  3 passed (3)\n      Tests  10 passed (10)';
    expect(parseTestCounts(out)).toEqual({ pass: 10, fail: 0 });
  });

  it('parses pytest "===== N passed, N failed in T.Ts ====="', () => {
    const out = '===== 8 passed, 1 failed in 1.20s =====';
    expect(parseTestCounts(out)).toEqual({ pass: 8, fail: 1 });
  });

  it('parses pytest pass-only summary', () => {
    const out = '===== 8 passed in 0.40s =====';
    expect(parseTestCounts(out)).toEqual({ pass: 8, fail: 0 });
  });

  it('parses pytest failed-only summary', () => {
    const out = '===== 2 failed in 0.40s =====';
    expect(parseTestCounts(out)).toEqual({ pass: 0, fail: 2 });
  });

  it('parses mocha "N passing" + "N failing"', () => {
    const out = '\n  42 passing (1s)\n  3 failing\n';
    expect(parseTestCounts(out)).toEqual({ pass: 42, fail: 3 });
  });

  it('parses mocha failed-only summaries', () => {
    const out = '\n  3 failing\n';
    expect(parseTestCounts(out)).toEqual({ pass: 0, fail: 3 });
  });

  it('parses cargo test "test result: ok. N passed; N failed; ..."', () => {
    const out = 'test result: ok. 7 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out';
    expect(parseTestCounts(out)).toEqual({ pass: 7, fail: 2 });
  });
});

describe('classifyIterationErrors', () => {
  it('returns [] for empty output', () => {
    expect(classifyIterationErrors('')).toEqual([]);
  });

  it('returns [] when no recognised error pattern appears', () => {
    expect(classifyIterationErrors('all green, nothing to report')).toEqual([]);
  });

  it('classifies TypeScript errors into "ts-<code>" buckets', () => {
    const out = "src/foo.ts(12,5): error TS2304: Cannot find name 'foo'.\n";
    const errs = classifyIterationErrors(out);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.bucket === 'ts-2304')).toBe(true);
  });

  it('classifies XxxError-style runtime errors into runtime-<name> buckets (covers Python and JS uniformly)', () => {
    const out = 'Traceback (most recent call last):\n  File "x.py", line 3, in <module>\nValueError: bad value\n';
    const errs = classifyIterationErrors(out);
    expect(errs.some((e) => e.bucket === 'runtime-valueerror')).toBe(true);
  });

  it('does not double-record the same XxxError under different language buckets', () => {
    const out = 'TypeError: cannot read property foo of undefined\n';
    const errs = classifyIterationErrors(out);
    // Exactly one record — both Python-style and JS-style patterns route to
    // the same runtime-<name> bucket so signal E sees a single occurrence.
    expect(errs.filter((e) => e.bucket.startsWith('runtime-'))).toHaveLength(1);
    expect(errs[0].bucket).toBe('runtime-typeerror');
  });

  it('classifies generic test failure lines', () => {
    const out = 'FAILED tests/foo.spec.ts > should work\n';
    const errs = classifyIterationErrors(out);
    expect(errs.some((e) => e.bucket === 'test-failure')).toBe(true);
  });

  it('deduplicates identical errors (same bucket + same excerpt)', () => {
    const out = 'error TS2304: Cannot find name foo\nerror TS2304: Cannot find name foo\n';
    const errs = classifyIterationErrors(out);
    const ts2304 = errs.filter((e) => e.bucket === 'ts-2304');
    expect(ts2304.length).toBe(1);
  });

  it('caps the number of distinct errors to keep iteration size bounded', () => {
    // Construct 50 distinct TS error codes.
    let out = '';
    for (let i = 1000; i < 1050; i++) out += `error TS${i}: msg ${i}\n`;
    const errs = classifyIterationErrors(out);
    expect(errs.length).toBeLessThanOrEqual(10);
  });
});
