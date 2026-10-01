/**
 * Network readiness probe for unattended work that must not start while the
 * host has no working DNS.
 *
 * On 2026-09-29 the Mac woke from hibernate at 14:14:04 and an overdue
 * automation fired within a second, before Wi-Fi and DNS were back (Cursor's
 * model discovery logged `getaddrinfo ENOTFOUND api2.cursor.sh` in the same
 * window). Codex surfaced the dead network as "workspace routing discovery
 * failed", and the run spent all three retry attempts inside the ~3 minute
 * outage and gave up. The same sessions worked when resumed at 14:24.
 *
 * Resolution goes through Chromium's host resolver (`net.resolveHost`), not
 * Node's `dns.lookup`: a `getaddrinfo` call that hangs while offline would pin
 * a libuv threadpool thread and stall main-process file I/O.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('NetworkReadiness');

export type HostResolver = (host: string) => Promise<unknown>;

/** Hosts the provider CLIs depend on. Any one resolving means DNS works. */
export const NETWORK_PROBE_HOSTS: readonly string[] = ['chatgpt.com', 'api.anthropic.com', 'api.github.com'];
export const NETWORK_PROBE_TIMEOUT_MS = 5_000;
export const NETWORK_READY_POLL_MS = 10_000;
/** After this, callers proceed anyway and rely on their normal failure handling. */
export const NETWORK_READY_MAX_WAIT_MS = 10 * 60_000;

export interface NetworkReadyResult {
  ready: boolean;
  waitedMs: number;
}

export interface NetworkReadinessOptions {
  /** `null` means no resolver is available; readiness is then assumed (fail open). */
  resolver?: HostResolver | null;
  hosts?: readonly string[];
  probeTimeoutMs?: number;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

let cachedResolver: HostResolver | null | undefined;

/**
 * Chromium's resolver with the DNS cache bypassed, so a stale pre-sleep entry
 * cannot report a network that is not there. `null` outside Electron (worker
 * processes, unit tests), where the probe fails open.
 */
export function getDefaultHostResolver(): HostResolver | null {
  if (cachedResolver !== undefined) return cachedResolver;
  try {
    const { net } = require('electron') as typeof import('electron'); // eslint-disable-line @typescript-eslint/no-require-imports
    cachedResolver = typeof net?.resolveHost === 'function'
      ? (host) => net.resolveHost(host, { cacheUsage: 'disallowed' })
      : null;
  } catch {
    cachedResolver = null;
  }
  return cachedResolver;
}

/**
 * True when any probe host resolves. Hosts are resolved in parallel under one
 * shared timeout, so a probe never costs more than `probeTimeoutMs` even when
 * DNS hangs rather than failing fast (the usual state just after a wake).
 */
export function isNetworkReachable(options: NetworkReadinessOptions = {}): Promise<boolean> {
  const resolver = options.resolver === undefined ? getDefaultHostResolver() : options.resolver;
  const hosts = options.hosts ?? NETWORK_PROBE_HOSTS;
  if (!resolver || hosts.length === 0) return Promise.resolve(true);
  const timeoutMs = options.probeTimeoutMs ?? NETWORK_PROBE_TIMEOUT_MS;
  return new Promise<boolean>((resolve) => {
    let failures = 0;
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    const settle = (reachable: boolean) => {
      clearTimeout(timer);
      resolve(reachable);
    };
    for (const host of hosts) {
      Promise.resolve()
        .then(() => resolver(host))
        .then(
          () => settle(true),
          () => {
            if (++failures === hosts.length) settle(false);
          },
        );
    }
  });
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/**
 * Poll until DNS works or `maxWaitMs` elapses. Never throws. `ready: false`
 * means the wait gave up, not that the caller must stop.
 */
export async function waitForNetworkReady(options: NetworkReadinessOptions = {}): Promise<NetworkReadyResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? NETWORK_READY_POLL_MS;
  const maxWaitMs = options.maxWaitMs ?? NETWORK_READY_MAX_WAIT_MS;
  const startedAt = now();
  for (;;) {
    if (await isNetworkReachable(options)) {
      return { ready: true, waitedMs: now() - startedAt };
    }
    const elapsed = now() - startedAt;
    if (elapsed >= maxWaitMs) {
      logger.warn('Network still unreachable; giving up the readiness wait', { waitedMs: elapsed });
      return { ready: false, waitedMs: elapsed };
    }
    await sleep(Math.min(pollMs, maxWaitMs - elapsed));
  }
}

export function _resetNetworkReadinessForTesting(): void {
  cachedResolver = undefined;
}
