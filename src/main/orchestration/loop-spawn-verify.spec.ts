import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spawnVerifyCommand } from './loop-spawn-verify';

const runNode = (script: string) => spawnVerifyCommand(script, process.cwd(), 5_000, 'verify', false, {
  buildInvocation: code => ({ file: process.execPath, args: ['-e', code], useShellOption: false }),
  classifyFailure: () => 'command',
});

describe('spawnVerifyCommand output capture', () => {
  it.each(['stdout', 'stderr'] as const)('reports truncation when a real child fills %s beyond the cap', async stream => {
    const result = await runNode(`process.${stream}.write('x'.repeat(200001), () => process.exit(1))`);
    expect(result.status).toBe('failed'); expect(result.outputTruncated).toBe(true);
    expect(result.output.match(/x/g)).toHaveLength(200_000);
  });
  it('does not mark complete output as truncated at the exact cap', async () => {
    const result = await runNode("process.stdout.write('x'.repeat(200000), () => process.exit(1))");
    expect(result.outputTruncated).not.toBe(true); expect(result.output.length).toBe(200_000);
  });
  it('marks truncation for a passing command too', async () => {
    const result = await runNode("process.stdout.write('x'.repeat(200001))");
    expect(result.status).toBe('passed'); expect(result.outputTruncated).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('spawnVerifyCommand leftovers', () => {
  const isAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const waitGone = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 50 && isAlive(pid); i += 1) await new Promise(resolve => setTimeout(resolve, 100));
    return !isAlive(pid);
  };
  const runShell = (script: string, timeoutMs = 5_000) => spawnVerifyCommand(script, process.cwd(), timeoutMs, 'verify', false, {
    buildInvocation: code => ({ file: '/bin/sh', args: ['-c', code], useShellOption: false }),
    classifyFailure: () => 'command',
  });

  it('stops a program a passing verify left in the background', async () => {
    const result = await runShell('sleep 60 > /dev/null 2>&1 & echo "leftover=$!"');
    const pid = Number(/leftover=(\d+)/.exec(result.output)?.[1]);
    try {
      expect(result.status).toBe('passed');
      expect(Number.isInteger(pid)).toBe(true);
      expect(await waitGone(pid)).toBe(true);
    } finally {
      if (Number.isInteger(pid) && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('does not hold a passing verify until its timeout when a leftover keeps the output open', async () => {
    const started = Date.now();
    const result = await runShell('sleep 60 & echo "leftover=$!"', 20_000);
    const pid = Number(/leftover=(\d+)/.exec(result.output)?.[1]);
    try {
      expect(result.status).toBe('passed');
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await waitGone(pid)).toBe(true);
    } finally {
      if (Number.isInteger(pid) && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 40_000);

  it('stops a background program when the verify times out', async () => {
    const result = await runShell('sleep 60 > /dev/null 2>&1 & echo "leftover=$!"; sleep 30', 1_000);
    const pid = Number(/leftover=(\d+)/.exec(result.output)?.[1]);
    try {
      expect(result).toMatchObject({ status: 'failed', failureKind: 'timeout' });
      expect(await waitGone(pid)).toBe(true);
    } finally {
      if (Number.isInteger(pid) && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 40_000);

  it.runIf(existsSync('/usr/bin/perl'))('still stops a descendant that left the group (setsid) when the verify times out', async () => {
    // perl puts itself in a new session, then becomes `sleep`: a child of the shell outside its group.
    const result = await runShell(
      `/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "60"' > /dev/null 2>&1 & echo "leftover=$!"; sleep 30`,
      1_000,
    );
    const pid = Number(/leftover=(\d+)/.exec(result.output)?.[1]);
    try {
      expect(result).toMatchObject({ status: 'failed', failureKind: 'timeout' });
      expect(await waitGone(pid)).toBe(true);
    } finally {
      if (Number.isInteger(pid) && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 40_000);
});
