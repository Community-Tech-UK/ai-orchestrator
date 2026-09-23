import { getLogger } from '../logging/logger';
import {
  getTailscaleIpv4Address,
  isTailscaleIpv4Address,
  readTailscaleSelfStatus,
  type TailscaleSelfStatus,
} from '../util/network-addresses';

const logger = getLogger('CoordinatorTailscaleWatcher');

export const COORDINATOR_TAILSCALE_POLL_MS = 30_000;

/**
 * `running`: this machine is on its tailnet. `stopped`: Tailscale is installed
 * but not connected (switched off, logged out, starting). `absent`: no Tailscale
 * here at all, so there is nothing to warn about. `unknown`: not probed yet.
 */
export type CoordinatorTailscaleState = 'running' | 'stopped' | 'absent' | 'unknown';

export interface CoordinatorTailscaleProbeResult {
  state: Exclude<CoordinatorTailscaleState, 'unknown'>;
  backendState?: string;
}

export interface CoordinatorTailscaleProbeDeps {
  getTailscaleIp?: () => string | null;
  readStatus?: () => Promise<TailscaleSelfStatus | null>;
}

/**
 * Cheap first: a Tailscale interface address means the tunnel is up and no CLI
 * call is needed. Only when the interface is missing do we ask the CLI, which
 * is what separates "switched off" from "not installed".
 */
export async function probeCoordinatorTailscale(
  deps: CoordinatorTailscaleProbeDeps = {},
): Promise<CoordinatorTailscaleProbeResult> {
  if ((deps.getTailscaleIp ?? getTailscaleIpv4Address)()) return { state: 'running' };
  const status = await (deps.readStatus ?? readTailscaleSelfStatus)();
  if (!status) return { state: 'absent' };
  const backendState = status.backendState ?? undefined;
  return backendState === 'Running'
    ? { state: 'running', backendState }
    : { state: 'stopped', ...(backendState ? { backendState } : {}) };
}

export interface CoordinatorTailscaleWatcherDeps {
  probe?: () => Promise<CoordinatorTailscaleProbeResult>;
  /** Paired worker nodes (connected or not). No paired nodes means no warning. */
  listPairedNodes: () => { id: string; name: string }[];
  notify: (input: { title: string; body: string }) => void;
  /** Called after the probed state changes, e.g. to refresh node hints in the UI. */
  onStateChange?: (state: CoordinatorTailscaleState) => void;
  pollMs?: number;
}

/**
 * Warns when this coordinator's Tailscale goes down while workers depend on it.
 *
 * On 2026-09-22 the Mac's Tailscale was switched off for 3.5 hours. windows-pc
 * reaches the coordinator over Tailscale, so it showed as offline the whole
 * time, and the only clue was a startup log line nobody reads. The worker was
 * healthy throughout, which is exactly why this has to be said out loud: every
 * other signal pointed at the worker.
 */
export class CoordinatorTailscaleWatcher {
  private state: CoordinatorTailscaleState = 'unknown';
  private backendState: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checkInFlight: Promise<void> | null = null;
  /** Nodes whose most recent connection arrived from a Tailscale address. */
  private readonly tailscaleNodes = new Map<string, string>();
  private readonly probe: () => Promise<CoordinatorTailscaleProbeResult>;

  constructor(private readonly deps: CoordinatorTailscaleWatcherDeps) {
    this.probe = deps.probe ?? (() => probeCoordinatorTailscale());
  }

  start(): void {
    if (this.timer) return;
    void this.checkNow();
    this.timer = setInterval(() => void this.checkNow(), this.deps.pollMs ?? COORDINATOR_TAILSCALE_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getState(): CoordinatorTailscaleState {
    return this.state;
  }

  /** Record which route a node used; only Tailscale-sourced nodes are named in warnings. */
  noteNodeConnected(node: { id: string; name: string; address?: string }): void {
    // A dual-stack listener reports IPv4 peers as IPv4-mapped IPv6.
    const address = node.address?.trim().replace(/^::ffff:/i, '');
    if (address && isTailscaleIpv4Address(address)) {
      this.tailscaleNodes.set(node.id, node.name);
    } else if (address) {
      this.tailscaleNodes.delete(node.id);
    }
  }

  /** Probe again soon after a disconnect, rather than waiting for the next poll. */
  noteNodeDisconnected(): void {
    void this.checkNow();
  }

  /** Operator-facing reason for a disconnected node, when this Mac's Tailscale explains it. */
  getDisconnectedNodeHint(nodeId: string): string | undefined {
    if (this.state !== 'stopped') return undefined;
    if (this.tailscaleNodes.has(nodeId)) {
      return 'Tailscale is off on this computer. This worker connects over Tailscale, so it cannot reach Harness until Tailscale is back on.';
    }
    // No route evidence this run (e.g. Harness started with Tailscale already off).
    return this.tailscaleNodes.size === 0
      ? 'Tailscale is off on this computer. If this worker connects over Tailscale, it cannot reach Harness until Tailscale is back on.'
      : undefined;
  }

  checkNow(): Promise<void> {
    this.checkInFlight ??= this.runCheck().finally(() => {
      this.checkInFlight = null;
    });
    return this.checkInFlight;
  }

  private async runCheck(): Promise<void> {
    let result: CoordinatorTailscaleProbeResult;
    try {
      result = await this.probe();
    } catch (error) {
      logger.warn('Tailscale probe failed', { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const previous = this.state;
    this.state = result.state;
    this.backendState = result.backendState;
    if (result.state === previous) return;
    logger.info('Coordinator Tailscale state changed', { from: previous, to: result.state, backendState: result.backendState });
    if (result.state === 'stopped') this.warn();
    this.deps.onStateChange?.(result.state);
  }

  private warn(): void {
    const paired = this.deps.listPairedNodes();
    if (paired.length === 0) return;
    const named = paired.filter((node) => this.tailscaleNodes.has(node.id)).map((node) => node.name);
    const who = named.length > 0
      ? `${named.join(', ')} ${named.length === 1 ? 'connects' : 'connect'} to Harness over Tailscale and cannot reach it`
      : 'Worker nodes that connect over Tailscale cannot reach Harness';
    const state = this.backendState ? ` (Tailscale reports "${this.backendState}")` : '';
    logger.warn('Coordinator Tailscale is not running while worker nodes are paired', {
      backendState: this.backendState,
      tailscaleNodes: named,
    });
    this.deps.notify({
      title: 'Tailscale is off on this computer',
      body: `${who} until Tailscale is turned back on${state}.`,
    });
  }
}

let activeWatcher: CoordinatorTailscaleWatcher | null = null;

/** The watcher started by the worker-node subsystem, or null when that subsystem is off. */
export function getActiveCoordinatorTailscaleWatcher(): CoordinatorTailscaleWatcher | null {
  return activeWatcher;
}

export function setActiveCoordinatorTailscaleWatcher(watcher: CoordinatorTailscaleWatcher | null): void {
  activeWatcher?.stop();
  activeWatcher = watcher;
}

export function _resetCoordinatorTailscaleWatcherForTesting(): void {
  setActiveCoordinatorTailscaleWatcher(null);
}
