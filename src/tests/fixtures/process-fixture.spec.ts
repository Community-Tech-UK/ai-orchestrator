import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureFixtureSpawns, isFixtureProcessAlive, ProcessFixtureRegistry, waitForFixtureProcessExit } from './process-fixture';

it('stops a tracked fixture before a delayed PID-file write after setup fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aio-fixture-early-failure-'));
  const pidFile = join(dir, 'child.pid');
  const fixtures = new ProcessFixtureRegistry();
  fixtures.trackPidFile(pidFile);
  let child: ChildProcess | undefined;
  try {
    child = fixtures.track(spawn(process.execPath, ['-e',
      'setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],String(process.pid)),1000);setInterval(()=>{},1000)',
      pidFile,
    ], { detached: process.platform !== 'win32', stdio: 'ignore' }));
    await once(child, 'spawn');
    expect(isFixtureProcessAlive(child.pid!)).toBe(true);
    await expect(access(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });

    const failedSetup = async () => {
      try {
        throw new Error('fixture setup failed before PID receipt');
      } finally {
        await fixtures.cleanup();
      }
    };
    await expect(failedSetup()).rejects.toThrow('fixture setup failed before PID receipt');
    await waitForFixtureProcessExit(child.pid!);
    await expect(access(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    // Keep this test leak-free even if the registry implementation regresses.
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForFixtureProcessExit(child.pid);
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

it.each(['exitCode', 'signalCode'] as const)(
  'does not kill a replacement PID from a captured root whose %s proves exit',
  async (exitEvidence) => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-fixture-reused-pid-'));
    const pidFile = join(dir, 'old-root.pid');
    const fixtures = new ProcessFixtureRegistry();
    let replacement: ChildProcess | undefined;
    try {
      replacement = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      await once(replacement, 'spawn');
      // Model kernel PID reuse with an exited handle and ONLY our own real
      // replacement process. The old handle has no authority over this child.
      fixtures.track({
        pid: replacement.pid,
        exitCode: exitEvidence === 'exitCode' ? 0 : null,
        signalCode: exitEvidence === 'signalCode' ? 'SIGTERM' : null,
      } as ChildProcess);
      fixtures.trackPidFile(pidFile);
      await writeFile(pidFile, String(replacement.pid));
      expect(isFixtureProcessAlive(replacement.pid!)).toBe(true);

      await fixtures.waitForExit();
      await fixtures.cleanup();
      expect(isFixtureProcessAlive(replacement.pid!)).toBe(true);
    } finally {
      if (replacement?.pid && replacement.exitCode === null && replacement.signalCode === null) {
        replacement.kill('SIGKILL');
        await waitForFixtureProcessExit(replacement.pid);
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000,
);

it('captures a real launch through a previously imported spawn before PID-file receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aio-fixture-bound-spawn-'));
  const pidFile = join(dir, 'child.pid');
  const fixtures = new ProcessFixtureRegistry();
  const captured: ChildProcess[] = [];
  const restore = captureFixtureSpawns(fixtures, (child) => captured.push(child));
  fixtures.trackPidFile(pidFile);
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ['-e',
      'setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],String(process.pid)),1000);setInterval(()=>{},1000)',
      pidFile,
    ], { detached: process.platform !== 'win32', stdio: 'ignore' });
    await once(child, 'spawn');
    expect(captured).toContain(child);
    await expect(access(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await fixtures.cleanup();
    await waitForFixtureProcessExit(child.pid!);
    await expect(access(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    try {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForFixtureProcessExit(child.pid);
      }
    } finally {
      restore();
      await rm(dir, { recursive: true, force: true });
    }
  }
}, 10_000);
