import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  captureFixtureSpawns,
  exitOnceProcessGone,
  isFixtureProcessAlive,
  ProcessFixtureRegistry,
  waitForFixtureProcessExit,
} from './process-fixture';

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

it.each([
  ['an empty receipt left by a writer killed mid-write', ''],
  ['a whitespace-only receipt', ' \n'],
  ['a non-numeric receipt', 'not-a-pid'],
  ['a truncated receipt', '12x'],
  ['a receipt below the valid PID range', '0'],
])('tolerates %s instead of failing fixture cleanup', async (_label, content) => {
  const dir = await mkdtemp(join(tmpdir(), 'aio-fixture-corrupt-receipt-'));
  const pidFile = join(dir, 'child.pid');
  const fixtures = new ProcessFixtureRegistry();
  fixtures.trackPidFile(pidFile);
  try {
    await writeFile(pidFile, content);
    await expect(fixtures.waitForExit()).resolves.toBeUndefined();
    await expect(fixtures.cleanup()).resolves.toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('still kills a live process named by a valid receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aio-fixture-valid-receipt-'));
  const pidFile = join(dir, 'descendant.pid');
  const fixtures = new ProcessFixtureRegistry();
  fixtures.trackPidFile(pidFile);
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    await writeFile(pidFile, String(child.pid));
    expect(isFixtureProcessAlive(child.pid!)).toBe(true);

    await fixtures.cleanup();
    await waitForFixtureProcessExit(child.pid!);
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForFixtureProcessExit(child.pid);
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

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

it('ends a signal-ignoring fixture once the process that started it is gone, and not before', async () => {
  const fixtures = new ProcessFixtureRegistry();
  try {
    // Stands in for a test worker that is killed outright mid-test, so neither the code under test nor cleanup runs.
    const worker = fixtures.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await once(worker, 'spawn');
    const child = fixtures.spawn(process.execPath, ['-e',
      `process.on("SIGTERM",()=>{});setInterval(()=>{${exitOnceProcessGone(worker.pid)}},50)`,
    ], { stdio: 'ignore' });
    await once(child, 'spawn');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isFixtureProcessAlive(child.pid!)).toBe(true);

    worker.kill('SIGKILL');
    await waitForFixtureProcessExit(child.pid!, 5_000);
  } finally {
    await fixtures.cleanup();
  }
}, 10_000);
