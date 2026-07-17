/**
 * Disconnect lifecycle for worker-node sockets: the short re-registration
 * grace window (flap protection) and, for stream-durable workers (WS15), the
 * longer parked-work window during which in-flight WORK RPCs survive a true
 * disconnect so a reconnecting worker can still complete them.
 *
 * Extracted from WorkerNodeConnectionServer so the timer interlocks are
 * isolated and the connection file stays within its LOC budget. All state
 * queries and side effects go through the injected deps — this class owns
 * ONLY the timers.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('WorkerNodeConnection');

/**
 * How long a node's registry entry and in-flight RPCs are held after the
 * active socket closes, waiting for a re-registration. A flapping link (or a
 * worker doing a fast reconnect) that re-registers within this window is
 * treated as a single continuous session. Kept short so a genuine disconnect
 * is still noticed promptly.
 */
export const DISCONNECT_GRACE_MS = 2_500;

/**
 * WS15 — how long WORK RPCs (unbounded dispatches like instance.sendInput)
 * survive a true disconnect of a stream-durable worker before being rejected.
 * A worker that reconnects within this window completes them normally (the
 * pending map still holds the request id). Non-durable workers keep the
 * immediate rejection.
 */
export const PARKED_WORK_RPC_WINDOW_MS = 60_000;

export interface DisconnectLifecycleDeps {
  isNodeConnected(nodeId: string): boolean;
  /** Does the node advertise stream durability (WS15 handshake flag)? */
  isDurableNode(nodeId: string): boolean;
  /** Does the node currently have parked-eligible (work) RPCs in flight? */
  hasPendingWork(nodeId: string): boolean;
  rejectPending(nodeId: string, reason: string, filter: 'all' | 'non-work' | 'work'): void;
  /** Grace elapsed with no re-registration — emit the true-disconnect signal. */
  onTrueDisconnect(nodeId: string): void;
}

export class ConnectionDisconnectLifecycle {
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly parkedRejectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: DisconnectLifecycleDeps) {}

  /** Schedule a "true disconnect" unless the node re-registers in time. */
  beginGrace(nodeId: string): void {
    const existing = this.graceTimers.get(nodeId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.graceTimers.delete(nodeId);
      if (this.deps.isNodeConnected(nodeId)) return;
      // WS15: durable workers keep WORK RPCs parked for a longer window; a
      // reconnect within it completes them and replays the output gap.
      if (this.deps.isDurableNode(nodeId)) {
        this.deps.rejectPending(nodeId, `Node disconnected: ${nodeId}`, 'non-work');
        this.beginParkedWorkRejection(nodeId);
      } else {
        this.deps.rejectPending(nodeId, `Node disconnected: ${nodeId}`, 'all');
      }
      this.deps.onTrueDisconnect(nodeId);
    }, DISCONNECT_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.graceTimers.set(nodeId, timer);
  }

  /**
   * The node re-registered: cancel both windows. Returns true when a grace
   * window was in progress (the session is treated as continuous).
   */
  cancelOnReregister(nodeId: string): boolean {
    const parked = this.parkedRejectTimers.get(nodeId);
    if (parked) {
      clearTimeout(parked);
      this.parkedRejectTimers.delete(nodeId);
      logger.info('Durable worker reconnected — parked work RPCs resume', { nodeId });
    }
    const grace = this.graceTimers.get(nodeId);
    if (!grace) return false;
    clearTimeout(grace);
    this.graceTimers.delete(nodeId);
    return true;
  }

  clearAll(): void {
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    for (const timer of this.parkedRejectTimers.values()) clearTimeout(timer);
    this.parkedRejectTimers.clear();
  }

  private beginParkedWorkRejection(nodeId: string): void {
    const existing = this.parkedRejectTimers.get(nodeId);
    if (existing) clearTimeout(existing);
    if (!this.deps.hasPendingWork(nodeId)) return;
    logger.info('Parking in-flight work RPCs for durable worker reconnect', {
      nodeId,
      windowMs: PARKED_WORK_RPC_WINDOW_MS,
    });
    const timer = setTimeout(() => {
      this.parkedRejectTimers.delete(nodeId);
      if (this.deps.isNodeConnected(nodeId)) return;
      this.deps.rejectPending(
        nodeId,
        `Node disconnected: ${nodeId} (parked-work window elapsed)`,
        'work',
      );
    }, PARKED_WORK_RPC_WINDOW_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.parkedRejectTimers.set(nodeId, timer);
  }
}
