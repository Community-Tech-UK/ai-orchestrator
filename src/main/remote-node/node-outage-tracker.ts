import type { WorkerHostHealthSample, WorkerNodeInfo } from '../../shared/types/worker-node.types';

/**
 * Why a worker node was away, judged from what it reports when it comes back.
 * - host-restarted: the operating system booted during the outage.
 * - worker-restarted: a new worker process, but the same boot (or boot unknown).
 * - network: the same worker process throughout: unreachable, or asleep/frozen.
 * - unknown: the worker does not report enough to tell.
 */
export type NodeOutageCause = 'host-restarted' | 'worker-restarted' | 'network' | 'unknown';

export interface NodeRecovery {
  nodeId: string;
  name: string;
  downForMs: number;
  cause: NodeOutageCause;
  /** False when the worker is too old to report its boot time. */
  hostBootKnown: boolean;
  /** Plain-English notes about abnormal host resources just before the drop. */
  healthWarnings: string[];
}

interface OutageRecord {
  name: string;
  lastHeardAt: number;
  workerStartedAt?: number;
  hostBootedAt?: number;
  hostHealth?: WorkerHostHealthSample;
}

/** os.uptime()-derived boot times drift by seconds between samples. */
const HOST_BOOT_TOLERANCE_MS = 2 * 60_000;
export const UDP_ENDPOINT_WARNING_THRESHOLD = 5_000;
/**
 * A sample older than this when the node was last heard from is not "just
 * before it dropped": the sampler keeps its last good sample when PowerShell
 * fails, which is likeliest during the very exhaustion it watches.
 */
export const HOST_HEALTH_MAX_AGE_MS = 15 * 60_000;
export const PROCESS_HANDLE_WARNING_THRESHOLD = 50_000;

/**
 * Remembers what each announced-disconnected node looked like, so its
 * reconnect can be reported with how long it was away and why. Only nodes that
 * were announced as disconnected are tracked: a reconnect inside the grace
 * window, or a first connect after app start, yields no recovery.
 */
export class NodeOutageTracker {
  private readonly down = new Map<string, OutageRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  noteDisconnected(node: WorkerNodeInfo): void {
    const agent = node.capabilities.workerAgent;
    this.down.set(node.id, {
      name: node.name,
      lastHeardAt: node.lastHeartbeat ?? node.connectedAt ?? this.now(),
      ...(agent?.startedAt !== undefined ? { workerStartedAt: agent.startedAt } : {}),
      ...(agent?.hostBootedAt !== undefined ? { hostBootedAt: agent.hostBootedAt } : {}),
      ...(node.capabilities.hostHealth ? { hostHealth: node.capabilities.hostHealth } : {}),
    });
  }

  noteConnected(node: WorkerNodeInfo): NodeRecovery | null {
    const record = this.down.get(node.id);
    if (!record) return null;
    this.down.delete(node.id);
    const agent = node.capabilities.workerAgent;
    return {
      nodeId: node.id,
      name: node.name || record.name,
      downForMs: Math.max(0, this.now() - record.lastHeardAt),
      cause: classifyOutageCause(record, agent?.startedAt, agent?.hostBootedAt),
      hostBootKnown: agent?.hostBootedAt !== undefined,
      healthWarnings: isRecentSample(record.hostHealth, record.lastHeardAt)
        ? describeHostHealthWarnings(record.hostHealth)
        : [],
    };
  }
}

export function classifyOutageCause(
  before: Pick<OutageRecord, 'lastHeardAt' | 'workerStartedAt' | 'hostBootedAt'>,
  workerStartedAt: number | undefined,
  hostBootedAt: number | undefined,
): NodeOutageCause {
  if (hostBootedAt !== undefined) {
    const bootedDuringOutage = before.hostBootedAt !== undefined
      ? hostBootedAt - before.hostBootedAt > HOST_BOOT_TOLERANCE_MS
      : hostBootedAt > before.lastHeardAt - HOST_BOOT_TOLERANCE_MS;
    if (bootedDuringOutage) return 'host-restarted';
  }
  if (workerStartedAt === undefined) return 'unknown';
  if (before.workerStartedAt !== undefined) {
    return workerStartedAt === before.workerStartedAt ? 'network' : 'worker-restarted';
  }
  return workerStartedAt > before.lastHeardAt ? 'worker-restarted' : 'unknown';
}

function isRecentSample(sample: WorkerHostHealthSample | undefined, lastHeardAt: number): boolean {
  return sample !== undefined && lastHeardAt - sample.sampledAt <= HOST_HEALTH_MAX_AGE_MS;
}

export function describeHostHealthWarnings(sample: WorkerHostHealthSample | undefined): string[] {
  if (!sample) return [];
  // The request-path heartbeat stores raw, unvalidated capabilities, so treat
  // the lists as untrusted shapes.
  const udpOwners = Array.isArray(sample.topUdpOwners) ? sample.topUdpOwners : [];
  const handleHolders = Array.isArray(sample.topHandleHolders) ? sample.topHandleHolders : [];
  const warnings: string[] = [];
  if (sample.udpEndpoints > UDP_ENDPOINT_WARNING_THRESHOLD) {
    const owner = udpOwners[0];
    warnings.push(
      `Windows was using ${sample.udpEndpoints.toLocaleString('en-GB')} network ports`
      + (owner ? `, most of them by ${owner.name} (${owner.count.toLocaleString('en-GB')})` : '')
      + '.',
    );
  }
  for (const holder of handleHolders) {
    if (holder && holder.count > PROCESS_HANDLE_WARNING_THRESHOLD) {
      warnings.push(
        `${holder.name} was holding ${holder.count.toLocaleString('en-GB')} system handles, which suggests a leak.`,
      );
    }
  }
  return warnings;
}

export function formatOutageDuration(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function formatRecoveryNotification(recovery: NodeRecovery): { title: string; body: string } {
  const sentences = [`It was offline for ${formatOutageDuration(recovery.downForMs)}.`];
  const cause = describeCause(recovery);
  if (cause) sentences.push(cause);
  if (recovery.healthWarnings.length > 0) {
    sentences.push(`Just before it dropped: ${recovery.healthWarnings.join(' ')}`);
  }
  return { title: `${recovery.name} is back online`, body: sentences.join(' ') };
}

function describeCause(recovery: NodeRecovery): string | undefined {
  switch (recovery.cause) {
    case 'host-restarted':
      return 'The computer restarted.';
    case 'worker-restarted':
      return recovery.hostBootKnown
        // Not "the computer stayed on": Windows Fast Startup keeps the boot
        // clock running across a shutdown, so only a full restart is ruled out.
        ? 'The Harness worker program on it restarted; the computer did not do a full restart.'
        : 'The Harness worker program on it restarted (possibly because the computer restarted).';
    case 'network':
      // Same process and boot: a network drop, but a sleeping or frozen
      // computer (console QuickEdit, suspend) looks identical from here.
      return 'The Harness worker program kept running but could not reach this Mac '
        + '(a network drop, or the computer was asleep or frozen).';
    default:
      return undefined;
  }
}
