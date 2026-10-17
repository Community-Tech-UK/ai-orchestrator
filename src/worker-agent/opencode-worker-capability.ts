import { resolveOpenCodeLaunch } from '../main/cli/adapters/opencode-cli-launch';

let cache: { expires: number; value: 1 | 2 | undefined } | undefined;
let inFlight: Promise<1 | 2 | undefined> | undefined;

/** Heartbeats reuse selection for a minute; helper commands still verify their own install. */
export function readWorkerOpenCodeMajor(): Promise<1 | 2 | undefined> {
  if (cache && cache.expires > Date.now()) return Promise.resolve(cache.value);
  if (inFlight) return inFlight;
  inFlight = resolveOpenCodeLaunch().then((launch) => launch.major === 1 || launch.major === 2 ? launch.major : undefined, () => undefined)
    .then((value) => { cache = { expires: Date.now() + 60_000, value }; return value; })
    .finally(() => { inFlight = undefined; });
  return inFlight;
}

export function resetWorkerOpenCodeMajorForTesting(): void { cache = undefined; inFlight = undefined; }
