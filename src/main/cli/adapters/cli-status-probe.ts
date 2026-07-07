import type { ChildProcess } from 'node:child_process';
import type { CliStatus } from './base-cli-adapter.types';

export interface VersionStatusProbeResult {
  output: string;
  stdout: string;
  stderr: string;
  code: number | null;
  version: string | undefined;
}

export interface VersionStatusProbeOptions {
  spawn: () => ChildProcess;
  path: string;
  timeoutMs?: number;
  timeoutError: string;
  spawnError: (error: Error) => string;
  unavailableError: (result: VersionStatusProbeResult) => string;
  isAvailable: (result: VersionStatusProbeResult) => boolean;
  authenticated?: (result: VersionStatusProbeResult) => boolean;
  metadata?: (result: VersionStatusProbeResult) => Record<string, unknown> | undefined;
  killSignal?: NodeJS.Signals;
  versionFallback?: string;
  outputFormat?: 'concat' | 'separate';
  includeVersionOnUnavailable?: boolean;
}

const VERSION_RE = /(\d+\.\d+\.\d+)/;

export function probeVersionStatus(options: VersionStatusProbeOptions): Promise<CliStatus> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const versionFallback = options.versionFallback ?? 'unknown';
  const outputFormat = options.outputFormat ?? 'concat';

  return new Promise<CliStatus>((resolve) => {
    const proc = options.spawn();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (status: CliStatus): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(status);
    };

    timeout = setTimeout(() => {
      try {
        options.killSignal ? proc.kill(options.killSignal) : proc.kill();
      } catch {
        // Process may already be gone.
      }
      finish({ available: false, error: options.timeoutError });
    }, timeoutMs);

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      const output = outputFormat === 'separate' ? `${stdout}\n${stderr}` : `${stdout}${stderr}`;
      const result: VersionStatusProbeResult = {
        output,
        stdout,
        stderr,
        code,
        version: output.match(VERSION_RE)?.[1],
      };

      if (options.isAvailable(result)) {
        const status: CliStatus = {
          available: true,
          version: result.version ?? versionFallback,
          path: options.path,
          authenticated: options.authenticated ? options.authenticated(result) : true,
        };
        const metadata = options.metadata?.(result);
        if (metadata !== undefined) status.metadata = metadata;
        finish(status);
        return;
      }

      const status: CliStatus = {
        available: false,
        error: options.unavailableError(result),
      };
      if (options.includeVersionOnUnavailable) {
        status.version = result.version ?? versionFallback;
      }
      finish(status);
    });

    proc.on('error', (err) => {
      finish({
        available: false,
        error: options.spawnError(err instanceof Error ? err : new Error(String(err))),
      });
    });
  });
}
