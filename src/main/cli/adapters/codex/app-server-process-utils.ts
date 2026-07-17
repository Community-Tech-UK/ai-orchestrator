/**
 * Process/endpoint utilities for the Codex app-server transports: broker
 * endpoint parsing, process-tree termination, and the app-server availability
 * preflight. Split from app-server-client.ts, which re-exports the public
 * surface so existing importers (and their vi.mock overrides) are unaffected.
 */

import { spawnSync } from 'child_process';
import { getLogger } from '../../../logging/logger';
import { getSafeEnvForTrustedProcess } from '../../../security/env-filter';
import { buildCliSpawnOptions } from '../../cli-environment';

const logger = getLogger('CodexAppServerClient');

/**
 * Parses a broker endpoint string into a socket path.
 * Formats: `unix:/path/to/broker.sock` or `pipe:\\.\pipe\name`
 */
export function parseBrokerEndpoint(endpoint: string): string | null {
  if (endpoint.startsWith('unix:')) {
    return endpoint.slice(5);
  }
  if (endpoint.startsWith('pipe:')) {
    return endpoint.slice(5);
  }
  // Bare path — treat as Unix socket
  if (endpoint.startsWith('/') || endpoint.startsWith('\\\\.\\pipe\\')) {
    return endpoint;
  }
  return null;
}

/**
 * Cross-platform process tree termination.
 *
 * - Windows: `taskkill /PID /T /F` to kill the entire process tree
 * - Unix: `process.kill(-pid, 'SIGTERM')` to kill the process group,
 *   with fallback to single-process kill
 */
export function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;

  const isWindows = process.platform === 'win32';

  if (isWindows) {
    try {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 5000,
      });
      if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
        // taskkill not available, fall back to single process kill
        try { process.kill(pid); } catch { /* already dead */ }
      }
    } catch {
      try { process.kill(pid); } catch { /* already dead */ }
    }
    return;
  }

  // Unix: kill process group (negative PID)
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      // Process group kill failed for non-ESRCH reason — try single kill
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    }
    // ESRCH = no such process, already dead — that's fine
  }
}

/**
 * Returns the sanitized environment used for Codex launch preflights.
 * PATH expansion and Windows shell handling are layered in by
 * `buildCliSpawnOptions()` so this stays aligned with the real launch path.
 */
function buildCheckEnv(): Record<string, string> {
  return getSafeEnvForTrustedProcess() as Record<string, string>;
}

/**
 * Checks whether `codex app-server` is available by running `codex app-server --help`.
 * Returns true if the subcommand exists, false otherwise.
 *
 * When this returns false the adapter silently falls back to exec mode, which
 * has its own downsides (cold-start cost per turn, no native resume). Logging
 * the failure reason is critical — otherwise "why is exec mode being used?"
 * becomes unanswerable without reattaching a debugger.
 */
export function checkAppServerAvailability(): boolean {
  try {
    const spawnOptions = buildCliSpawnOptions(buildCheckEnv());
    const result = spawnSync('codex', ['app-server', '--help'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions,
    });

    const stdout = result.stdout?.toString() ?? '';
    const stderr = result.stderr?.toString() ?? '';
    const available = result.status === 0 || stdout.includes('app-server');

    if (!available) {
      logger.warn('codex app-server subcommand not available — falling back to exec mode', {
        status: result.status,
        signal: result.signal,
        timedOut: result.signal === 'SIGTERM' || (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
        errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
        errorMessage: result.error?.message,
        stdoutPreview: stdout.slice(0, 200),
        stderrPreview: stderr.slice(0, 200),
      });
    }

    return available;
  } catch (err) {
    logger.warn('codex app-server check threw — falling back to exec mode', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
