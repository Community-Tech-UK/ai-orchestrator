/**
 * LT-1093, with real processes and no mocks: a provider CLI runs its shell commands in a process group of their own,
 * so stopping the CLI by group used to leave them running, orphaned under pid 1. Everything started here expires by
 * itself within 30 seconds even if the assertions fail.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { killProcessGroup } from '../adapters/base-cli-process-utils';

const posixIt = process.platform === 'win32' ? it.skip : it;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (done()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return done();
}

describe('killProcessGroup with a command in its own process group', () => {
  posixIt('stops the command the CLI started, not just the CLI', async () => {
    const wrapper = [
      "const { spawn } = require('node:child_process');",
      "const shell = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });",
      "process.stdout.write(String(shell.pid) + '\\n');",
      'setTimeout(() => {}, 30000);',
    ].join('\n');
    const cli = spawn(process.execPath, ['-e', wrapper], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const shellPid = await new Promise<number>((resolve, reject) => {
      cli.stdout!.once('data', chunk => resolve(Number(String(chunk).trim())));
      cli.once('error', reject);
    });
    try {
      expect(alive(shellPid)).toBe(true);
      expect(killProcessGroup(cli.pid, 'SIGTERM')).toBe(true);
      expect(await waitUntil(() => !alive(cli.pid!), 5000)).toBe(true);
      expect(await waitUntil(() => !alive(shellPid), 5000)).toBe(true);
    } finally {
      if (alive(shellPid)) process.kill(shellPid, 'SIGKILL');
      if (cli.pid && alive(cli.pid)) process.kill(cli.pid, 'SIGKILL');
    }
  });
});
