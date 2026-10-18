import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const runner = path.resolve('scripts/run-related-tests.mjs');
const fixtures: string[] = [];

function fixture(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'aio-related-tests-'));
  fixtures.push(cwd);
  // No repository-wide discovery in this subprocess regression. Dependencies
  // resolve from the installed runner; the fixture config needs no imports.
  writeFileSync(path.join(cwd, 'vitest.config.mjs'), 'export default { test: { globals: true, environment: "node", maxWorkers: 1, minWorkers: 1 } };');
  writeFileSync(path.join(cwd, 'shared.js'), 'export const value = 42;');
  writeFileSync(path.join(cwd, 'other.js'), 'export const value = 7;');
  for (const [name, dependency] of [['first', 'shared'], ['second', 'shared'], ['unrelated', 'other']]) {
    writeFileSync(path.join(cwd, `${name}.test.js`), `
      import { appendFileSync } from 'node:fs';
      import { value } from './${dependency}.js';
      test('${name}', () => {
        expect(value).toBe(${dependency === 'shared' ? 42 : 7});
        appendFileSync('executed.txt', '${name}\\n');
      });
    `);
  }
  return cwd;
}

function run(cwd: string, input: string) {
  return spawnSync(process.execPath, [runner], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NODE_OPTIONS: '', AIO_TEST_MAX_FORKS: '1' },
  });
}

afterEach(() => {
  for (const cwd of fixtures.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('run-related-tests subprocess', () => {
  it('runs both dependants exactly once and excludes unrelated tests', () => {
    const cwd = fixture();
    const result = run(cwd, JSON.stringify(['shared.js', 'first.test.js', 'shared.js']));
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(path.join(cwd, 'executed.txt'), 'utf8').trim().split('\n').sort()).toEqual(['first', 'second']);
  }, 40_000);

  it('propagates a real failing related test', () => {
    const cwd = fixture();
    writeFileSync(path.join(cwd, 'shared.js'), 'export const value = 0;');
    const result = run(cwd, JSON.stringify(['shared.js']));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('expected +0 to be 42');
  }, 40_000);

  it('accepts an empty or unmatched selection without running unrelated tests', () => {
    const cwd = fixture();
    for (const files of [[], ['missing.js']]) {
      const result = run(cwd, JSON.stringify(files));
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
    expect(() => readFileSync(path.join(cwd, 'executed.txt'))).toThrow();
  }, 40_000);

  it('rejects malformed or non-path input', () => {
    const cwd = fixture();
    for (const input of ['invalid json', '{}', '[42]', '[" "]']) {
      const result = run(cwd, input);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
    }
  }, 40_000);
});
