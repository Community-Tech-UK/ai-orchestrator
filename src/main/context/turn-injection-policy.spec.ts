import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { TurnInjectionPolicy } from './turn-injection-policy';
describe('turn injection policy', () => {
  it('skips short continuations and repeated identifiers but allows new paths', () => {
    const policy = new TurnInjectionPolicy();
    expect(policy.begin('session', 0, 'continue').retrieve).toBe(false);
    expect(policy.begin('session', 0, 'Investigate src/first.ts migration transaction failure').code).toBe(true);
    expect(policy.take(['rlm:one'], 200)).toBe(true);
    expect(policy.take(['rlm:one'], 200)).toBe(false);
    expect(policy.begin('session', 0, 'Investigate src/first.ts migration transaction failure').code).toBe(false);
    expect(policy.begin('session', 0, 'Investigate src/second.ts migration transaction failure').code).toBe(true);
  });
  it('recognizes a new path after a long lowercase token', () => {
    const policy = new TurnInjectionPolicy();
    const message = 'a'.repeat(1_024) + ' Investigate migration transaction failure src/first.ts';
    expect(policy.begin('session', 0, message).code).toBe(true);
    expect(policy.begin('session', 0, message).code).toBe(false);
    expect(policy.begin('session', 0, message.replace('first.ts', 'second.ts')).code).toBe(true);
  });
  it('handles the supported 500K input within a bounded worker and retains tail identifiers', async () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), 'turn-injection-policy.ts');
    const esbuildPath = createRequire(import.meta.url).resolve('esbuild');
    const worker = new Worker(`
      const compiled = require(${JSON.stringify(esbuildPath)}).buildSync({ entryPoints: [${JSON.stringify(sourcePath)}],
        bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
      const production = { exports: {} };
      new Function('module', 'exports', 'require', compiled)(production, production.exports, require);
      const { parentPort } = require('node:worker_threads');
      const policy = new production.exports.TurnInjectionPolicy();
      const tail = ' Investigate migration transaction failure first.ts.';
      const message = 'a'.repeat(500000 - tail.length) + tail;
      const first = policy.begin('session', 0, message);
      const repeated = policy.begin('session', 0, message);
      const fresh = policy.begin('session', 0, message.replace('first.ts.', 'other.ts.'));
      parentPort.postMessage({ first, repeated, fresh });
    `, { eval: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Production matcher exceeded the 3s worker bound')), 3_000);
        worker.once('message', resolve); worker.once('error', reject);
      });
      expect(result).toEqual({ first: { retrieve: true, code: true },
        repeated: { retrieve: true, code: false }, fresh: { retrieve: true, code: true } });
    } finally { clearTimeout(timer); await worker.terminate(); }
  });
  it.each(['src/first.ts', 'src\\first.ts', 'first.ts', 'firstSymbol', 'first_symbol', '$firstSymbol'])(
    'recognizes new identifiers and repeated topics: %s', (identifier) => {
      const policy = new TurnInjectionPolicy();
      const message = 'Investigate migration transaction failure ' + identifier;
      policy.begin('session', 0, 'Investigate migration transaction failure');
      expect(policy.begin('session', 0, message).code).toBe(true);
      expect(policy.begin('session', 0, message).code).toBe(false);
    },
  );
  it.each([
    ['first.ts.', 'second.ts.'], ['firstSymbol.', 'secondSymbol.'],
    ['(first.ts)', '(second.ts)'], ['`first_symbol`', '`second_symbol`'],
  ])('recognizes a new identifier in punctuated prose: %s', (first, second) => {
    const policy = new TurnInjectionPolicy();
    const message = (name: string) => 'Investigate migration transaction failure ' + name;
    policy.begin('session', 0, message(first));
    expect(policy.begin('session', 0, message(first)).code).toBe(false);
    expect(policy.begin('session', 0, message(second)).code).toBe(true);
    expect(policy.begin('session', 0, message(second)).code).toBe(false);
  });
  it('caps at 8K tokens and resets repeat state on session/epoch boundaries', () => {
    const policy = new TurnInjectionPolicy(); policy.begin('a', 0, 'Investigate every migration transaction failure');
    expect(policy.take(['rlm:one'], 8000)).toBe(true);
    expect(policy.begin('a', 0, 'Review another module with new logic').retrieve).toBe(false);
    expect(policy.take(['rlm:two'], 1)).toBe(false);
    policy.begin('a', 1, 'Review another module with new logic');
    expect(policy.take(['rlm:one'], 10)).toBe(true);
    policy.begin('b', 1, 'Review another module with new logic');
    expect(policy.take(['rlm:one'], 10)).toBe(true);
  });
});
