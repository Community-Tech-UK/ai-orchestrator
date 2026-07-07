import { execFile } from 'node:child_process';
import type { BwCommandResult, BwRunner } from './browser-credential-vault';

/**
 * Default Bitwarden `bw` CLI runner for the credential vault.
 *
 * Runs `bw` with array args (no shell interpolation) and the BW_SESSION token
 * injected into the child's env only — never on the command line, never logged.
 * The execFile function is injectable so the runner unit-tests without a real
 * `bw` binary.
 */

type ExecFileFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: 'utf-8' },
  callback: (
    error: (Error & { code?: number | string }) | null,
    stdout: string,
    stderr: string,
  ) => void,
) => void;

export interface BwRunnerOptions {
  /** Path to the bw binary. Default 'bw' (resolved from PATH). */
  binary?: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to node:child_process execFile. */
  execFileFn?: ExecFileFn;
  /** Base environment to inherit (default process.env). */
  baseEnv?: NodeJS.ProcessEnv;
}

export function createBwRunner(options: BwRunnerOptions = {}): BwRunner {
  const binary = options.binary ?? 'bw';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const execFileFn = options.execFileFn ?? (execFile as unknown as ExecFileFn);
  const baseEnv = options.baseEnv ?? process.env;

  return {
    run(
      args: string[],
      opts?: { input?: string; session?: string; env?: Record<string, string> },
    ): Promise<BwCommandResult> {
      const env: NodeJS.ProcessEnv = { ...baseEnv, ...(opts?.env ?? {}) };
      if (opts?.session) {
        // Session key travels in the child env only — not argv, not logs.
        env['BW_SESSION'] = opts.session;
      }
      return new Promise<BwCommandResult>((resolve) => {
        execFileFn(
          binary,
          args,
          { env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
          (error, stdout, stderr) => {
            if (error) {
              const code = typeof error.code === 'number' ? error.code : 1;
              resolve({ stdout: stdout ?? '', stderr: stderr ?? error.message, code });
              return;
            }
            resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: 0 });
          },
        );
      });
    },
  };
}
