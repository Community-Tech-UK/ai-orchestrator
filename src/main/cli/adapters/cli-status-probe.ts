import type { ChildProcess } from 'node:child_process';
import { getLogger } from '../../logging/logger';
import {
  getClampedLoadWatchdogMultiplier,
  isRuntimeOverloadedNow,
} from '../../runtime/system-load-monitor';
import type { CliStatus } from './base-cli-adapter.types';

const logger = getLogger('CliStatusProbe');

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
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
  /** Injectable host-pressure signal for tests. Defaults to the system load monitor. */
  isHostStarved?: () => boolean;
}

const VERSION_RE = /(\d+\.\d+\.\d+)/;

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * `<cli> --version` answers in well under a second on a calm host, so the
 * probe stretches less far under load than the stream/RPC watchdogs do.
 */
const MAX_LOAD_MULTIPLIER = 4;

/**
 * How late the timeout callback may fire, relative to its own deadline, before
 * we blame a blocked main event loop rather than the child. A blocked loop
 * cannot deliver the child's `close` event, so the budget expires without the
 * probe ever having observed the CLI.
 */
const STARVED_TIMER_LATENESS_MS = 500;

interface VersionStatusProbeAttempt {
  status: CliStatus;
  timedOut: boolean;
  /** True when the host, not the CLI, is the likely reason the budget expired. */
  starved: boolean;
}

function probeOnce(
  options: VersionStatusProbeOptions,
  timeoutMs: number,
): Promise<VersionStatusProbeAttempt> {
  const now = options.now ?? Date.now;
  const isHostStarved = options.isHostStarved ?? isRuntimeOverloadedNow;
  const versionFallback = options.versionFallback ?? 'unknown';
  const outputFormat = options.outputFormat ?? 'concat';

  return new Promise<VersionStatusProbeAttempt>((resolve) => {
    const startedAt = now();
    const proc = options.spawn();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (status: CliStatus, timedOut = false, starved = false): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ status, timedOut, starved });
    };

    timeout = setTimeout(() => {
      const timerLatenessMs = now() - startedAt - timeoutMs;
      try {
        options.killSignal ? proc.kill(options.killSignal) : proc.kill();
      } catch {
        // Process may already be gone.
      }
      finish(
        { available: false, error: options.timeoutError },
        true,
        timerLatenessMs >= STARVED_TIMER_LATENESS_MS || isHostStarved(),
      );
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

export async function probeVersionStatus(options: VersionStatusProbeOptions): Promise<CliStatus> {
  const baseTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const first = await probeOnce(
    options,
    baseTimeoutMs * getClampedLoadWatchdogMultiplier(MAX_LOAD_MULTIPLIER),
  );
  if (!first.timedOut || !first.starved) {
    return first.status;
  }

  // The host ate the budget, so the first attempt proves nothing about the CLI:
  // a stalled main event loop cannot observe the child's exit at all. Retrying
  // once (with the now-elevated load multiplier) keeps a healthy CLI from
  // failing a spawn. 2026-07-25 incident: a 5.2s cold-start event-loop stall
  // timed out `codex --version`, which aborted a history restore's native
  // resume and downgraded the thread to replay fallback.
  const retryTimeoutMs = baseTimeoutMs * getClampedLoadWatchdogMultiplier(MAX_LOAD_MULTIPLIER);
  logger.warn('CLI version probe timed out while the host was starved; retrying once', {
    path: options.path,
    retryTimeoutMs,
  });
  const retry = await probeOnce(options, retryTimeoutMs);
  return retry.status;
}
