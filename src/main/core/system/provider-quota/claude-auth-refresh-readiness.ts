/**
 * Credential renewal must not start during a macOS maintenance wake.
 * Overdue timers can run before Electron delivers its resume event, so check
 * current capabilities at the point of use, then check both Claude hosts.
 * This is a conservative preflight, not a guarantee that Keychain is unlocked
 * or that the host cannot go to sleep after the check.
 */
import { execFile } from 'child_process';
import {
  getDefaultHostResolver,
  isNetworkReachable,
  type HostResolver,
} from '../../../runtime/network-readiness';

const REFRESH_HOSTS = ['platform.claude.com', 'api.anthropic.com'] as const;

export interface ClaudeAuthRefreshReadinessOptions {
  platform?: NodeJS.Platform;
  readPowerState?: () => Promise<string>;
  /** An unavailable resolver defers renewal rather than assuming readiness. */
  resolver?: HostResolver | null;
  probeTimeoutMs?: number;
}

/** Full graphical wake, rather than CPU/network-only maintenance wake. */
export function isClaudeRefreshPowerReady(output: string): boolean {
  const match = /^Current System Capabilities are:\s*([^\r\n]*)/m.exec(output);
  const capabilities = new Set(match?.[1]?.trim().split(/\s+/) ?? []);
  return ['CPU', 'Graphics', 'Network'].every((capability) => capabilities.has(capability));
}

export function createClaudeAuthRefreshReadiness(
  options: ClaudeAuthRefreshReadinessOptions = {},
): () => Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const readPowerState = options.readPowerState ?? defaultReadPowerState;
  const powerReady = async (): Promise<boolean> =>
    platform !== 'darwin' || isClaudeRefreshPowerReady(await readPowerState());

  return async () => {
    try {
      if (!await powerReady()) return false;
      const resolver = options.resolver === undefined ? getDefaultHostResolver() : options.resolver;
      if (!resolver) return false;
      // The generic network gate accepts any host. Auth requires both hosts;
      // no cache entry or another provider's DNS success may stand in for one.
      const reachable = await Promise.all(REFRESH_HOSTS.map((host) => isNetworkReachable({
        resolver,
        hosts: [host],
        probeTimeoutMs: options.probeTimeoutMs,
      })));
      return reachable.every(Boolean) && await powerReady();
    } catch {
      return false;
    }
  };
}

function defaultReadPowerState(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/pmset', ['-g', 'systemstate'], {
      timeout: 3_000,
      maxBuffer: 16 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
