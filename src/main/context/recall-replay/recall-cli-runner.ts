/** Bounded transport for the quarterly recall audit; no output is logged here. */
import { spawn } from 'node:child_process';
import type { ClaudeRunner } from './recall-pipeline';

const STOP_GRACE_MS = 10_000;
const RETIRE_GRACE_MS = 10_000;
const CLOSE_GRACE_MS = 2_000;

/** Cleanup must preserve the owned files if a child may still be using them. */
export class RecallProcessNotRetiredError extends Error {
  constructor() {
    super('The recall process did not stop after its deadline; its temporary files were retained.');
    this.name = 'RecallProcessNotRetiredError';
  }
}

export function makeRecallRunner(claudePath: string, env: Record<string, string>, launch: typeof spawn = spawn): ClaudeRunner {
  return invocation => new Promise((resolve, reject) => {
    // A group lets the deadline retire descendants which might otherwise retain the pipes.
    const grouped = process.platform !== 'win32';
    const child = launch(claudePath, invocation.args, {
      cwd: invocation.cwd, env, detached: grouped,
      stdio: [invocation.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let retireTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = (value: NodeJS.Signals): void => {
      if (grouped && child.pid !== undefined) {
        try { process.kill(-child.pid, value); return; } catch { /* fall through to the child */ }
      }
      try { child.kill(value); } catch { /* the retirement deadline still settles the call */ }
    };
    const finish = (exitCode: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(stopTimer); clearTimeout(retireTimer); clearTimeout(closeTimer);
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      if (error) reject(error);
      else resolve({ exitCode, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      if (settled) return;
      stopTimer = setTimeout(() => {
        signal('SIGKILL');
        if (settled) return;
        retireTimer = setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode);
          else finish(null, new RecallProcessNotRetiredError());
        }, RETIRE_GRACE_MS);
      }, STOP_GRACE_MS);
    }, invocation.timeoutMs);
    child.stdout?.on('data', chunk => { if (stdout.length < 64e6) stdout += chunk; });
    child.stderr?.on('data', chunk => { if (stderr.length < 1e6) stderr += chunk; });
    child.stdin?.on('error', () => { /* keep waiting for retirement, including EPIPE */ });
    child.once('error', () => {
      if (child.pid === undefined) finish(null);
    });
    child.once('exit', (code: number | null) => {
      if (settled) return;
      closeTimer = setTimeout(() => {
        if (grouped && child.pid !== undefined) signal('SIGKILL');
        finish(code);
      }, CLOSE_GRACE_MS);
    });
    child.once('close', (code: number | null) => finish(code));
    if (invocation.stdin !== undefined) child.stdin?.end(invocation.stdin);
  });
}
