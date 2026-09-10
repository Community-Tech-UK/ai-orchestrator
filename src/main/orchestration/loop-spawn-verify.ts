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

/**
 * LT-350: handle an external caller (loop cancellation) needs to force-kill a
 * verify child that has no CLI adapter or instance to hang cleanup off of.
 * `kill()` is idempotent and resolves once the process tree has been reaped
 * (or immediately if the verify has already settled on its own).
 */
export interface SpawnVerifyRegistration {
  kill: () => Promise<void>;
}

export interface SpawnVerifyOptions {
  /** Invoked synchronously right after the child is spawned. */
  onSpawn?: (registration: SpawnVerifyRegistration) => void;
}

export function spawnVerifyCommand(
  cmd: string,
  executionCwd: string,
  timeoutMs: number,
  label: 'verify' | 'quick-verify',
  isolated: boolean,
  helpers: SpawnVerifyHelpers,
  options?: SpawnVerifyOptions,
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
    let cancelledExternally = false;
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

    const reapAndFinish = async (reason: 'timeout' | 'cancelled'): Promise<void> => {
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
        output: `${stdout}\n${stderr}\n(${label} ${
          reason === 'timeout' ? `timed out after ${timeoutMs}ms` : 'was cancelled'
        })`,
        durationMs: Date.now() - started,
        exitCode: null,
        failureKind: reason,
        ...(typeof pid === 'number' ? { pid } : {}),
      });
    };

    const to = setTimeout(() => {
      timedOut = true;
      void reapAndFinish('timeout');
    }, timeoutMs);

    let killPromise: Promise<void> | null = null;
    options?.onSpawn?.({
      kill: () => {
        if (settled) return Promise.resolve();
        if (!killPromise) {
          cancelledExternally = true;
          clearTimeout(to);
          killPromise = reapAndFinish('cancelled');
        }
        return killPromise;
      },
    });

    child.on('close', (code) => {
      if (timedOut || cancelledExternally || settled) return;
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
