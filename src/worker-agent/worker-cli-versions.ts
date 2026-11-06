import { getCliDetectionService } from '../main/cli/cli-detection';
import type { WorkerNodeCapabilities } from '../shared/types/worker-node.types';

let cache: { expiresAt: number; versions: NonNullable<WorkerNodeCapabilities['cliVersions']> } | undefined;
let inFlight: Promise<NonNullable<WorkerNodeCapabilities['cliVersions']>> | undefined;

/** Bound heartbeat probes and use the same machine-local detection as adapters. */
export function readWorkerCliVersions(): Promise<NonNullable<WorkerNodeCapabilities['cliVersions']>> {
  if (cache && cache.expiresAt > Date.now()) return Promise.resolve(cache.versions);
  if (inFlight) return inFlight;
  inFlight = getCliDetectionService().detectOne('claude').then(info => {
    const versions = info.installed && info.version && /^\d+\.\d+\.\d+$/.test(info.version) ? { claude: info.version } : {};
    cache = { expiresAt: Date.now() + 60_000, versions };
    return versions;
  }, () => {
    cache = { expiresAt: Date.now() + 60_000, versions: {} };
    return {};
  }).finally(() => { inFlight = undefined; });
  return inFlight;
}

export function resetWorkerCliVersionsForTesting(): void { cache = undefined; inFlight = undefined; }
