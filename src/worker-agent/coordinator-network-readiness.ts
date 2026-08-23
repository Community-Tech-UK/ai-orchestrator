import { createConnection } from 'node:net';

export const COORDINATOR_PROBE_TIMEOUT_MS = 2_500;

export type CoordinatorCandidateProbe = (
  url: string,
  signal: AbortSignal,
) => Promise<boolean>;

/** Build the ordered, de-duplicated set of configured coordinator routes. */
export function buildCoordinatorCandidates(
  active: string | null | undefined,
  primary: string | undefined,
  fallbacks: string[] | undefined,
): string[] {
  const ordered = [active, primary, ...(fallbacks ?? [])];
  return [...new Set(
    ordered.filter((url): url is string => typeof url === 'string' && url.length > 0),
  )];
}

/**
 * Check whether the coordinator's TCP endpoint is reachable without sending
 * credentials or starting a WebSocket handshake.
 */
export function probeCoordinatorCandidate(
  rawUrl: string,
  signal?: AbortSignal,
  timeoutMs = COORDINATOR_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let endpoint: URL;
    try {
      endpoint = new URL(rawUrl);
    } catch {
      resolve(false);
      return;
    }

    const host = endpoint.hostname.replace(/^\[|\]$/g, '');
    const port = endpoint.port
      ? Number.parseInt(endpoint.port, 10)
      : endpoint.protocol === 'wss:' ? 443 : 80;
    let settled = false;
    const socket = createConnection({ host, port });
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      resolve(reachable);
    };
    const abort = (): void => finish(false);

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    if (signal?.aborted) {
      finish(false);
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Probe all configured routes concurrently and return the first one that is
 * reachable. Cancelling the losing probes prevents a stale LAN fallback from
 * extending a retry cycle after a Tailscale or DNS route has recovered.
 */
export function firstReachableCoordinatorCandidate(
  candidates: string[],
  probe: CoordinatorCandidateProbe = probeCoordinatorCandidate,
): Promise<string | null> {
  if (candidates.length === 0) {
    return Promise.resolve(null);
  }

  const controller = new AbortController();
  return new Promise<string | null>((resolve) => {
    const results = new Array<boolean | undefined>(candidates.length).fill(undefined);
    let settled = false;
    const considerResults = (): void => {
      if (settled) return;
      const winnerIndex = results.findIndex(
        (reachable, index) => reachable === true
          && results.slice(0, index).every((earlier) => earlier === false),
      );
      if (winnerIndex >= 0) {
        settled = true;
        controller.abort();
        resolve(candidates[winnerIndex]);
      } else if (results.every((reachable) => reachable !== undefined)) {
        settled = true;
        resolve(null);
      }
    };

    for (const [index, candidate] of candidates.entries()) {
      void probe(candidate, controller.signal).then(
        (reachable) => {
          if (settled) return;
          results[index] = reachable;
          considerResults();
        },
        () => {
          if (settled) return;
          results[index] = false;
          considerResults();
        },
      );
    }
  });
}
