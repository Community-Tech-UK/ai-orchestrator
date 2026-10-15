import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractVerifyFailureKeys } from './verify-failure-keys';
import type { VerifyFailureKind } from './loop-completion-detector';

// Captured from this repo's quiet Vitest runner, Vitest default reporter,
// typecheck:spec, and ESLint stylish. ESLint fixture cwd was replaced with /repo.
const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__/verify-failure-keys');
const fixture = (name: string) => readFileSync(resolve(fixtureDirectory, `${name}.txt`), 'utf8');
const parse = (output: string) => extractVerifyFailureKeys(output, { truncated: false, failureKind: 'command' });

describe('extractVerifyFailureKeys', () => {
  it.each([
    '⎯⎯⎯ Unhandled Errors ⎯⎯⎯\nVitest caught 1 unhandled error during the test run.',
    '⎯⎯⎯ Unhandled Rejection ⎯⎯⎯\nError: unexpected asynchronous failure',
    '⎯⎯⎯ Uncaught Exception ⎯⎯⎯\nError: unexpected asynchronous failure',
    '⎯⎯⎯ Source Errors ⎯⎯⎯\nVitest found 1 error not related to your test files.',
  ])('rejects supported failures mixed with Vitest framework error blocks: %s', (unsupported) => {
    expect(parse(fixture('vitest-standard') + '\n' + unsupported)).toEqual({ keys: new Map(), parse: 'none' });
  });

  it.each([
    '\n> harness@0.1.0 backend-check\nFAILED tests/test_backend.py::test_new_regression',
    '\n FAIL src/b.spec.ts [ src/b.spec.ts ]\nError: Failed to load url missing-module',
    '\n[ERROR] Failed to execute goal org.apache.maven',
    '\n× unknown oxlint failure',
  ])('fails closed on unsupported failures alongside recognized ones: %s', (unsupported) => {
    const supported = '> harness@0.1.0 typecheck\nsrc/a.ts(1,1): error TS2304: Missing x';
    expect(parse(supported + unsupported)).toEqual({ keys: new Map(), parse: 'none' });
  });

  it.each(['vitest-quiet', 'vitest-standard'])('parses %s without counting the reporter summary twice', name => {
    const result = parse(fixture(name));
    expect(result.parse).toBe('complete'); expect(result.failedStep).toBe('test:quiet');
    expect(result.keys.size).toBe(1); expect([...result.keys.values()]).toEqual([1]);
    expect([...result.keys.keys()][0]).toMatch(/^test:quiet\|vitest\|src\/main\/app\/keep-awake-service.spec.ts\|KeepAwakeService keeps polling when a renderer broadcast throws\|[a-f0-9]{16}$/);
  });
  it('keys tsc diagnostics by step, file, code and message independent of coordinates', () => {
    const original = fixture('tsc'); const result = parse(original);
    expect(result.parse).toBe('complete'); expect(result.failedStep).toBe('typecheck:spec');
    expect([...result.keys.keys()][0]).toMatch(/^typecheck:spec\|tsc\|src\/main\/app\/keep-awake-service.spec.ts\|TS2322\|[a-f0-9]{16}$/);
    expect(parse(original.replace('(19,73)', '(200,1)')).keys).toEqual(result.keys);
    expect(parse(original.replace('void', 'string')).keys).not.toEqual(result.keys);
  });
  it('counts repeated identical errors as a multiset', () => {
    const line = "src/a.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'.";
    expect([...parse(line + '\n' + line.replace('(1,2)', '(40,9)')).keys.values()]).toEqual([2]);
  });
  it('parses real ESLint stylish rules, ignores coordinates and warnings', () => {
    const original = fixture('eslint-stylish'); const result = parse(original);
    expect(result.parse).toBe('complete'); expect(result.failedStep).toBe('lint'); expect(result.keys.size).toBe(2);
    expect([...result.keys.keys()].map(key => key.split('|').slice(0, 4))).toEqual([
      ['lint', 'eslint', '/repo/src/main/verify-failure-keys-fixture.ts', 'no-console'],
      ['lint', 'eslint', '/repo/src/main/verify-failure-keys-fixture.ts', '@typescript-eslint/no-unused-vars'],
    ]);
    expect(parse(original.replace('1:1', '90:4').replace('2:7', '103:5')).keys).toEqual(result.keys);
    expect(parse(original.replaceAll('  error  ', '  warning  ')).parse).toBe('none');
  });
  it('uses the last script before the failure and separates failures from different steps', () => {
    const diagnostic = "src/a.ts(1,1): error TS2322: incompatible types";
    const result = parse('> harness@0.1.0 verify\n> npm run first && npm run second\n> harness@0.1.0 first\n'
      + diagnostic + '\n> harness@0.1.0 second\n' + diagnostic);
    expect(result.failedStep).toBe('second'); expect(result.keys.size).toBe(2);
    expect([...result.keys.keys()].map(key => key.split('|')[0])).toEqual(['first', 'second']);
  });
  it('handles ANSI escapes and CRLF without changing the same failure key', () => {
    const original = fixture('tsc');
    expect(parse('\u001b[31m' + original.replaceAll('\n', '\r\n') + '\u001b[0m').keys).toEqual(parse(original).keys);
  });
  it.each(['timeout', 'infra', 'environment', 'cancelled'] satisfies VerifyFailureKind[])(
    'fails closed on %s even when output contains recognizable diagnostics', failureKind => {
      const result = extractVerifyFailureKeys(fixture('tsc'), { truncated: false, failureKind });
      expect(result.parse).toBe('none'); expect(result.keys.size).toBe(0);
    },
  );
  it('fails closed when captured output or the quiet runner report was truncated', () => {
    expect(extractVerifyFailureKeys(fixture('tsc'), { truncated: true, failureKind: 'command' }).parse).toBe('none');
    expect(parse(fixture('vitest-quiet') + '    …(truncated — see log)').parse).toBe('none');
    expect(parse(fixture('vitest-quiet') + '  …and 3 more failed test(s) — see log').parse).toBe('none');
  });
  it.each(['FAILED tests/test_a.py::test_a - AssertionError', '[ERROR] Failed to execute goal org.apache.maven', '× unknown oxlint failure', 'all checks passed'])('fails closed on unknown/no-failure output %s', output => {
    expect(parse(output)).toEqual({ keys: new Map(), parse: 'none' });
  });
  it('keeps distinct failing tests distinct even with the same error message', () => {
    const output = fixture('vitest-quiet');
    const second = output.replace('keeps polling when a renderer broadcast throws', 'releases a different session');
    expect(parse(output + '\n' + second).keys.size).toBe(2);
  });
  it('reads failed test bullets when no detailed FAIL block is printed', () => {
    const result = parse(' ❯ src/a.spec.ts (1 test | 1 failed) 5ms\n   × suite > works 2ms\n     → expected 1 to be 2');
    expect(result.parse).toBe('complete'); expect(result.keys.size).toBe(1);
  });
});
