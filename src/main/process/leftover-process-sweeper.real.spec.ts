/**
 * Incident replay with real processes: a fake session CLI starts a tool shell in
 * its own session (as OpenCode and Claude Code do), the shell backgrounds two
 * `sleep`s with their output discarded and exits 0, and the sweeper must still
 * attribute the orphans by recorded process group (Apple's `sleep` shows no
 * environment) and stop them. Needs a usable `ps`, so it skips where a sandbox
 * blocks it.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultHostProcessRuntime } from './host-process-inspector';
import { LeftoverProcessSweeper } from './leftover-process-sweeper';

function psWorks(): boolean {
  try {
    execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  return check();
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) {
    try { step(); } catch { /* already gone */ }
  }
});

describe.runIf(process.platform !== 'win32' && psWorks())('LeftoverProcessSweeper with real processes', () => {
  it('attributes and stops sleeps an exited tool shell left behind', async () => {
    // The "CLI": spawns the tool shell detached (new session), reports the leftover pids, stays alive.
    const cliScript = [
      "const { spawn } = require('node:child_process');",
      "const sh = spawn('/bin/sh', ['-c', 'sleep 120 > /dev/null 2>&1 & echo $!; sleep 120 > /dev/null 2>&1 & echo $!; sleep 2'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });",
      "sh.stdout.pipe(process.stdout);",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const cli: ChildProcess = spawn(process.execPath, ['-e', cliScript], { stdio: ['ignore', 'pipe', 'ignore'] });
    cleanup.push(() => cli.kill('SIGKILL'));
    let out = '';
    cli.stdout!.on('data', chunk => { out += String(chunk); });
    expect(await waitFor(() => out.trim().split(/\s+/).length >= 2)).toBe(true);
    const sleeps = out.trim().split(/\s+/).map(Number);
    for (const pid of sleeps) cleanup.push(() => process.kill(pid, 'SIGKILL'));

    const host = createDefaultHostProcessRuntime({ isInstanceLive: () => true, getLiveSessionPids: () => new Set([cli.pid!]) });
    const sweeper = new LeftoverProcessSweeper({
      platform: host.platform,
      uid: host.uid,
      harnessPid: process.pid,
      nowMs: () => Date.now(),
      runPs: host.runPs,
      kill: host.kill,
      getOwnerState: () => 'live',
      getSessionName: () => undefined,
      getLiveSessionRoots: () => new Map([[cli.pid!, 'sess-real']]),
      getLiveSessionPids: () => new Set([cli.pid!]),
      getMode: () => 'stop-cpu-hogs',
      notify: () => undefined,
      readLineage: () => null,
      writeLineage: () => undefined,
    });

    // While the shell is alive, its group is recorded under the session.
    await sweeper.refreshLineage();
    // The shell exits 0 after ~2 s; the sleeps are reparented to launchd.
    expect(await waitFor(() => execFileSync('ps', ['-o', 'ppid=', '-p', String(sleeps[0])]).toString().trim() === '1')).toBe(true);

    // An unrelated pid in the request is ignored; both sleeps are stopped.
    expect(await sweeper.stopAttributedAmong(new Set([...sleeps, cli.pid!]))).toBe(2);
    expect(await waitFor(() => sleeps.every(pid => !isAlive(pid)))).toBe(true);
    expect(isAlive(cli.pid!)).toBe(true);
  }, 30_000);
});
