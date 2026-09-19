import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetForTesting as resetCleanups, runCleanupFunctions } from '../util/cleanup-registry';
import { runInProcessGroup } from './plan-queue-process';

let dir: string;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function run(script: string, timeoutMs = 60_000) {
  return runInProcessGroup(script, [], {
    cwd: dir, env: process.env, shell: true, timeoutMs, outputTail: 4_000, label: 'the test command',
  });
}

async function expectStopped(pidFile: string): Promise<void> {
  const pid = Number(readFileSync(pidFile, 'utf-8').trim());
  await vi.waitFor(() => { if (isAlive(pid)) throw new Error(`process ${pid} still running`); }, { timeout: 5_000 });
}

beforeEach(() => {
  resetCleanups();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-process-')));
});

afterEach(() => {
  resetCleanups();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('runInProcessGroup', () => {
  it('returns the exit code and output of a command that finishes', async () => {
    expect(await run('echo hello; exit 3')).toEqual({ exitCode: 3, output: 'hello\n' });
  });

  it('kills everything the command started when it times out', async () => {
    const pidFile = join(dir, 'child.pid');
    const started = Date.now();

    const result = await run(`sleep 60 & echo $! > "${pidFile}"; wait`, 1_500);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('the test command timed out after 1500ms');
    expect(Date.now() - started).toBeLessThan(15_000);
    await expectStopped(pidFile);
  }, 20_000);

  it('returns promptly with the real exit code when a finished command leaves a process running, and stops it', async () => {
    const pidFile = join(dir, 'child.pid');
    const started = Date.now();

    const result = await run(`sleep 60 & echo $! > "${pidFile}"; echo done; exit 0`);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('done');
    expect(result.output).not.toContain('timed out');
    expect(result.output).toContain('left processes running; stopping them');
    expect(Date.now() - started).toBeLessThan(15_000);
    await expectStopped(pidFile);
  }, 20_000);

  describe('a process that moved itself out of the group', () => {
    let escaped: number | null = null;
    afterEach(() => {
      if (escaped && isAlive(escaped)) process.kill(escaped, 'SIGKILL');
      escaped = null;
    });

    /** Start `sleep 60` in its own process group, holding our output pipe, and record its pid. */
    function escapee(pidFile: string): string {
      const js = `const c=require('child_process').spawn('sleep',['60'],{detached:true,stdio:['ignore',1,2]});`
        + `require('fs').writeFileSync(process.argv[1],String(c.pid));c.unref()`;
      return `node -e "${js}" "${pidFile}"`;
    }

    it('does not hold the result after the command exits', async () => {
      const pidFile = join(dir, 'escaped.pid');
      const started = Date.now();

      const result = await run(`${escapee(pidFile)}; echo done; exit 0`);
      escaped = Number(readFileSync(pidFile, 'utf-8').trim());

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('done');
      expect(result.output).toContain('not waiting for it');
      expect(Date.now() - started).toBeLessThan(15_000);
    }, 20_000);

    it('does not hold the result after a timeout', async () => {
      const pidFile = join(dir, 'escaped.pid');
      const started = Date.now();

      const result = await run(`${escapee(pidFile)}; sleep 60`, 1_500);
      escaped = Number(readFileSync(pidFile, 'utf-8').trim());

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('timed out after 1500ms');
      expect(Date.now() - started).toBeLessThan(15_000);
    }, 20_000);
  });

  it('kills a running command and its children on app shutdown', async () => {
    const pidFile = join(dir, 'child.pid');
    const pending = run(`sleep 60 & echo $! > "${pidFile}"; wait`);
    await vi.waitFor(() => { if (!readFileSync(pidFile, 'utf-8').trim()) throw new Error('no pid yet'); }, { timeout: 5_000 });

    await runCleanupFunctions();

    expect((await pending).exitCode).not.toBe(0);
    await expectStopped(pidFile);
  }, 20_000);
});
