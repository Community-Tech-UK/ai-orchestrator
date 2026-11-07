import { execFile } from 'child_process';

export interface ProbeCommandResult {
  /** Exit code, or null when the command did not run to the end (timeout, missing, killed). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The executable does not exist. Distinct from a command that ran and failed. */
  notFound: boolean;
}

export type ProbeCommandRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<ProbeCommandResult>;

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Time-limited, non-blocking command runner for readiness probes. Never rejects: a failure is a result, so a probe
 * can tell "ran and said no" from "could not run" from "timed out". TERM is set because the macOS App Store
 * Tailscale binary starts its GUI, and prints no JSON, when it has neither TERM nor SHLVL.
 */
export const runProbeCommand: ProbeCommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, env: { ...process.env, TERM: process.env['TERM'] ?? 'dumb' } },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr, timedOut: false, notFound: false });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        const exitCode = typeof failure.code === 'number' ? failure.code : null;
        resolve({
          exitCode,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          timedOut: exitCode === null && failure.killed === true,
          notFound: failure.code === 'ENOENT',
        });
      },
    );
  });
