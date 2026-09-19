/**
 * Plan Queue child processes that run in an item's worktree (the landing
 * commit's hooks, the post-merge gate). Each runs in its own process group so
 * nothing it starts outlives it there:
 *   - on the timeout, the whole group is killed, not just the top process;
 *   - once the top process exits, anything left in its group is killed after a
 *     short grace, so a stray background process can neither keep the result
 *     waiting on its output pipe nor keep writing to the worktree;
 *   - on app shutdown (the cleanup registry), a running group is killed.
 *
 * The result never waits on a process it cannot kill: a short while after any
 * kill, our end of the output pipes is closed and the call returns. That covers
 * a process that moved itself out of the group (`setsid`, a detached spawn),
 * which no group kill reaches; it is reported in the output, not stopped. On
 * Windows `killProcessGroup` kills the process tree (`taskkill /T`), which
 * cannot reach descendants once the top process has exited.
 */

import { spawn } from 'child_process';
import { killProcessGroup } from '../cli/adapters/base-cli-process-utils';
import { registerCleanup } from '../util/cleanup-registry';

/** How long after the top process exits its leftovers may keep the output open. */
const EXIT_GRACE_MS = 2_000;
/** How long after a kill the output may stay open before the call stops waiting for it. */
const KILL_SETTLE_MS = 2_000;

export interface GroupRunResult {
  exitCode: number;
  output: string;
}

export function runInProcessGroup(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell?: boolean; timeoutMs: number; outputTail: number; label: string },
): Promise<GroupRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const killGroup = (): void => {
      if (!killProcessGroup(child.pid, 'SIGKILL')) child.kill('SIGKILL');
    };
    const unregister = registerCleanup(killGroup);
    let output = '';
    let exitCode: number | null = null;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf-8')).slice(-options.outputTail * 2);
    };
    const finish = (result: GroupRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (settle) clearTimeout(settle);
      unregister();
      resolve({ exitCode: result.exitCode, output: result.output.slice(-options.outputTail) });
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    /** Kill the group, then stop waiting for the output if something outside it still holds it. */
    const killAndSettle = (): void => {
      killGroup();
      if (settle) return;
      settle = setTimeout(() => {
        output += `\n[plan queue] ${options.label} left a process outside its group holding the output; not waiting for it`;
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ exitCode: exitCode ?? 1, output });
      }, KILL_SETTLE_MS);
    };

    const timer = setTimeout(() => {
      output += `\n[plan queue] ${options.label} timed out after ${options.timeoutMs}ms`;
      killAndSettle();
    }, options.timeoutMs);

    child.on('exit', (code) => {
      exitCode = code ?? 1;
      clearTimeout(timer);
      grace = setTimeout(() => {
        output += `\n[plan queue] ${options.label} left processes running; stopping them`;
        killAndSettle();
      }, EXIT_GRACE_MS);
    });
    child.on('error', (error) => {
      killGroup();
      finish({ exitCode: 1, output: `${output}\n${error.message}` });
    });
    child.on('close', (code) => {
      finish({ exitCode: exitCode ?? code ?? 1, output });
    });
  });
}
