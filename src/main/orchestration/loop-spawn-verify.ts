/**
 * L16 — spawn the loop verify command and reap its process tree on timeout.
 *
 * The login-shell wrapper (`zsh -lc npm run verify`) is the spawn we own.
 * `child.kill('SIGKILL')` ends that shell and leaves npm/vitest as `ppid=1`
 * orphans, which then contend with the next iteration's verify and blow the
 * 600s coordinator budget. Kill descendants, wait, then settle timeout.
 */

import { spawn } from 'node:child_process';
import type { VerifyFailureKind, VerifyOutcome } from './loop-completion-detector';
import {
  killProcessTree,
  waitOnPid,
  VERIFY_REAP_TIMEOUT_MS,
} from './loop-wait-on-pid';

export interface SpawnVerifyHelpers {
  buildInvocation: (cmd: string) => {
    file: string;
    args: string[];
    useShellOption: boolean;
  };
  classifyFailure: (output: string, isolated: boolean) => VerifyFailureKind;
}

export function spawnVerifyCommand(
  cmd: string,
  executionCwd: string,
  timeoutMs: number,
  label: 'verify' | 'quick-verify',
  isolated: boolean,
  helpers: SpawnVerifyHelpers,
): Promise<VerifyOutcome> {
  const started = Date.now();
  return new Promise<VerifyOutcome>((resolve) => {
    const inv = helpers.buildInvocation(cmd);
    const child = spawn(inv.file, inv.args, {
      cwd: executionCwd,
      shell: inv.useShellOption,
      env: {
        ...process.env,
        CI: '1',
        AIO_TEST_OUT_SUFFIX:
          process.env['AIO_TEST_OUT_SUFFIX']
          || `loop-verify-${process.pid}-${Date.now().toString(36)}`,
        AIO_TEST_NO_CACHE: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (outcome: VerifyOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      resolve(outcome);
    };
    const cap = (chunk: Buffer | string, target: 'stdout' | 'stderr') => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (target === 'stdout') {
        stdout += s;
        if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
      } else {
        stderr += s;
        if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
      }
    };
    child.stdout?.on('data', (b) => cap(b, 'stdout'));
    child.stderr?.on('data', (b) => cap(b, 'stderr'));

    const to = setTimeout(() => {
      timedOut = true;
      void (async () => {
        const pid = child.pid;
        killProcessTree(pid);
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        await waitOnPid({ pid, timeoutMs: VERIFY_REAP_TIMEOUT_MS });
        finish({
          status: 'failed',
          output: `${stdout}\n${stderr}\n(${label} timed out after ${timeoutMs}ms)`,
          durationMs: Date.now() - started,
          exitCode: null,
          failureKind: 'timeout',
          ...(typeof pid === 'number' ? { pid } : {}),
        });
      })();
    }, timeoutMs);

    child.on('close', (code) => {
      if (timedOut || settled) return;
      const output = `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`;
      if (code === 0) {
        finish({ status: 'passed', output, durationMs: Date.now() - started });
      } else {
        finish({
          status: 'failed',
          output,
          durationMs: Date.now() - started,
          exitCode: code,
          failureKind: helpers.classifyFailure(output, isolated),
        });
      }
    });
    child.on('error', (err) => {
      finish({
        status: 'failed',
        output: `${label} command failed to spawn: ${err.message}`,
        durationMs: Date.now() - started,
        exitCode: null,
        failureKind: 'infra',
      });
    });
  });
}
