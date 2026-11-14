import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeyedMutex } from './queue-keyed-mutex';
import { redactTail, runProcess } from './queue-process';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aio-queue-process-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runProcess', () => {
  it('returns the exit code and the end of the output', async () => {
    const ok = await runProcess(process.execPath, ['-e', 'console.log("hello")'], { cwd: dir, timeoutMs: 20_000 });
    expect(ok).toMatchObject({ code: 0, timedOut: false });
    expect(ok.tail).toContain('hello');
    const bad = await runProcess(process.execPath, ['-e', 'console.error("boom"); process.exit(3)'], { cwd: dir, timeoutMs: 20_000 });
    expect(bad).toMatchObject({ code: 3, timedOut: false });
    expect(bad.tail).toContain('boom');
  });

  it('stops a program at its time limit', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, timeoutMs: 400 });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it('reports a program that cannot start without throwing', async () => {
    const result = await runProcess('aio-no-such-program', [], { cwd: dir, timeoutMs: 5_000 });
    expect(result.code).toBeNull();
    expect(result.tail).toMatch(/ENOENT/);
  });

  it('blanks values that look like credentials', () => {
    const text = redactTail('npm ERR! _authToken=abc123 and password: hunter2 and Authorization: Bearer xyz.789 ok');
    expect(text).not.toMatch(/abc123|hunter2|xyz\.789/);
    expect(text).toContain('ok');
  });
});

describe('KeyedMutex', () => {
  it('runs one key at a time, other keys alongside, and carries on after a failure', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const slow = mutex.run('a', async () => { await new Promise(resolve => setTimeout(resolve, 50)); order.push('a1'); });
    const failing = mutex.run('a', async () => { order.push('a2'); throw new Error('x'); });
    const other = mutex.run('b', async () => { order.push('b'); });
    await Promise.all([slow, other, failing.catch(() => undefined)]);
    await mutex.run('a', async () => { order.push('a3'); });
    expect(order).toEqual(['b', 'a1', 'a2', 'a3']);
  });
});
