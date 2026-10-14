import { COORDINATOR_TO_NODE } from '../main/remote-node/worker-node-rpc';

/**
 * Coordinator housekeeping that arrives on a timer whether or not anyone is
 * using the node (`node.ping` every 10 s, health checks every minute, the
 * auxiliary inventory probe). Counting these as work would mean a connected
 * worker is never idle, so the self-updater would wait forever.
 */
const HOUSEKEEPING_METHODS = new Set<string>([
  COORDINATOR_TO_NODE.NODE_PING,
  COORDINATOR_TO_NODE.STREAM_RESUME,
  COORDINATOR_TO_NODE.SERVICE_STATUS,
  COORDINATOR_TO_NODE.LOCAL_AI_HEALTH_CHECK,
  COORDINATOR_TO_NODE.LOCAL_AI_HEALTH_DIAGNOSE,
  COORDINATOR_TO_NODE.AUXILIARY_MODEL_LIST,
  COORDINATOR_TO_NODE.PROVIDER_DIAGNOSE,
]);

/**
 * Short, self-contained requests: a restart must not cut one off, but once it
 * has answered nothing is left running. They block while in flight and do not
 * restart the quiet period. Busy sessions call the local model constantly, so
 * stamping these would also starve the updater.
 */
const IN_FLIGHT_ONLY_PREFIXES = ['fs.', 'sync.'];
const IN_FLIGHT_ONLY_METHODS = new Set<string>([
  COORDINATOR_TO_NODE.AUXILIARY_MODEL_GENERATE,
  COORDINATOR_TO_NODE.AUDIO_TRANSCRIBE,
  COORDINATOR_TO_NODE.CONFIG_UPDATE,
]);

type RequestWeight = 'ignore' | 'in_flight' | 'work';

export function classifyCoordinatorRequest(method: string | undefined): RequestWeight {
  if (!method) return 'work';
  if (HOUSEKEEPING_METHODS.has(method)) return 'ignore';
  if (IN_FLIGHT_ONLY_METHODS.has(method) || IN_FLIGHT_ONLY_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return 'in_flight';
  }
  return 'work';
}

/**
 * What the worker is doing right now, for anything that must not interrupt it
 * (the self-updater restarts the process, which would kill all of it).
 *
 * Two kinds of evidence. `countBusy` reads live state at the moment of asking
 * (instances, terminals, tunnels). Coordinator requests are counted for their
 * whole duration through `track`, because a short request can start and finish
 * between two samples. `lastActivityAt` covers work that is neither, such as a
 * browser command handed to the extension.
 */
export class WorkerActivity {
  private inFlight = 0;
  private lastTrackedAt = 0;

  constructor(
    private readonly countBusy: () => number,
    private readonly externalActivityAt: () => number = () => 0,
    private readonly now: () => number = Date.now,
  ) {}

  track<T>(method: string | undefined, work: Promise<T>): Promise<T> {
    const weight = classifyCoordinatorRequest(method);
    if (weight === 'ignore') return work;
    const stamp = weight === 'work';
    this.inFlight += 1;
    if (stamp) this.lastTrackedAt = this.now();
    return work.finally(() => {
      this.inFlight -= 1;
      if (stamp) this.lastTrackedAt = this.now();
    });
  }

  isBusy(): boolean {
    return this.inFlight > 0 || this.countBusy() > 0;
  }

  lastActivityAt(): number {
    return Math.max(this.lastTrackedAt, this.externalActivityAt());
  }
}
