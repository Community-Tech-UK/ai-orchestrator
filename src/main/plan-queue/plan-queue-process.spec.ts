import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetForTesting as resetCleanups, runCleanupFunctions } from '../util/cleanup-registry';
import { runInProcessGroup } from './plan-queue-process';
import { captureFixtureSpawns, ProcessFixtureRegistry, waitForFixtureProcessExit } from '../../tests/fixtures/process-fixture';

const fixtures = new ProcessFixtureRegistry();
const roots: ChildProcess[] = [];
let restoreSpawnCapture: () => void;

let dir: string;

function run(script: string, timeoutMs = 60_000) {
  return runInProcessGroup(script, [], {
    cwd: dir, env: process.env, shell: true, timeoutMs, outputTail: 4_000, label: 'the test command',
  });
}

/** Own the actual Node creator, including the period before its script begins. */
function runNode(script: string, timeoutMs = 60_000, nodeArgs: string[] = []) {
  return runInProcessGroup(process.execPath, [...nodeArgs, '-e', script], {
    cwd: dir, env: process.env, shell: false, timeoutMs, outputTail: 4_000, label: 'the test command',
  });
}

/** Real descendant keeps the output descriptors; detached descendants escape the group. */
function sleepFixture(pidFile: string, detached = false): string {
  fixtures.trackPidFile(pidFile);
  return `const c=require('node:child_process').spawn('sleep',['60'],{detached:${detached},stdio:['ignore',1,2]});`
    + `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();`;
}

async function expectStopped(pidFile: string): Promise<void> {
  const pid = Number(readFileSync(pidFile, 'utf-8').trim());
  await waitForFixtureProcessExit(pid, 5_000);
}

beforeEach(() => {
  restoreSpawnCapture = captureFixtureSpawns(fixtures, child => roots.push(child));
  resetCleanups();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-process-')));
});

afterEach(async () => {
  try {
    await runCleanupFunctions();
  } finally {
    try { await fixtures.cleanup(); } finally { restoreSpawnCapture(); }
    resetCleanups();
    roots.length = 0;
    vi.restoreAllMocks();
  }
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('runInProcessGroup', () => {
  it('returns the exit code and output of a command that finishes', async () => {
    expect(await run('echo hello; exit 3')).toEqual({ exitCode: 3, output: 'hello\n' });
  });

  it('kills everything the command started when it times out', async () => {
    const pidFile = join(dir, 'child.pid');
    const started = Date.now();

    const result = await runNode(sleepFixture(pidFile) + 'setInterval(() => {}, 1000);', 1_500);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('the test command timed out after 1500ms');
    expect(Date.now() - started).toBeLessThan(15_000);
    await expectStopped(pidFile);
  }, 20_000);

  it('returns promptly with the real exit code when a finished command leaves a process running, and stops it', async () => {
    const pidFile = join(dir, 'child.pid');
    const started = Date.now();

    const result = await runNode(sleepFixture(pidFile) + "console.log('done');process.exit(0);");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('done');
    expect(result.output).not.toContain('timed out');
    expect(result.output).toContain('left processes running; stopping them');
    expect(Date.now() - started).toBeLessThan(15_000);
    await expectStopped(pidFile);
  }, 20_000);

  describe('a process that moved itself out of the group', () => {
    it('does not hold the result after the command exits', async () => {
      const pidFile = join(dir, 'escaped.pid');
      const started = Date.now();

      const result = await runNode(sleepFixture(pidFile, true) + "console.log('done');process.exit(0);");

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('done');
      expect(result.output).toContain('not waiting for it');
      expect(Date.now() - started).toBeLessThan(15_000);
    }, 20_000);

    it('does not hold the result after a timeout', async () => {
      const pidFile = join(dir, 'escaped.pid');
      const started = Date.now();

      const result = await runNode(sleepFixture(pidFile, true) + 'setInterval(() => {}, 1000);', 1_500);

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('timed out after 1500ms');
      expect(Date.now() - started).toBeLessThan(15_000);
    }, 20_000);
  });

  it('stops a delayed Node creator before it can publish a PID or spawn a descendant', async () => {
    const preload = join(dir, 'delayed-startup.cjs');
    const pidFile = join(dir, 'late-child.pid');
    const startupFile = join(dir, 'startup.pid');
    writeFileSync(preload,
      `require('node:fs').writeFileSync(${JSON.stringify(startupFile)}, String(process.pid));`
        + 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);');
    const pending = runNode(sleepFixture(pidFile, true), 60_000, ['--require', preload]);
    const root = roots.at(-1)!;
    expect(root.pid).toBeGreaterThan(1);
    await vi.waitFor(() => expect(existsSync(startupFile)).toBe(true), { timeout: 5_000 });
    expect(Number(readFileSync(startupFile, 'utf8'))).toBe(root.pid);
    expect(existsSync(pidFile)).toBe(false);

    // Emulate an assertion/setup failure before the child script reports a PID.
    await fixtures.cleanup();
    await waitForFixtureProcessExit(root.pid!);
    expect((await pending).exitCode).not.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(existsSync(pidFile)).toBe(false);
  }, 10_000);

  it('kills a running command and its children on app shutdown', async () => {
    const pidFile = join(dir, 'child.pid');
    const pending = runNode(sleepFixture(pidFile) + 'setInterval(() => {}, 1000);');
    await vi.waitFor(() => { if (!readFileSync(pidFile, 'utf-8').trim()) throw new Error('no pid yet'); }, { timeout: 5_000 });

    await runCleanupFunctions();

    expect((await pending).exitCode).not.toBe(0);
    await expectStopped(pidFile);
  }, 20_000);
});
