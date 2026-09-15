/**
 * Flap-storm policy for worker-node sockets, extracted from
 * WorkerNodeConnectionServer.
 *
 * Two rules share one replace stream:
 * - fast: ≥10 replaces/re-registers in 60s (a link dropping every few seconds);
 * - slow: ≥4 replaces of a LIVE socket in 5min from one worker process (same
 *   stream epoch). This is the 2026-09-15 stale-close loop: a worker whose
 *   unscoped close handler wipes its healthy socket whenever the coordinator
 *   closes the one it replaced, so it reconnects every 15–30s forever while
 *   staying under the fast threshold.
 *
 * A slow storm asks the server to close the new active socket once. An old
 * worker then reconnects with no live socket to replace, so no stale close
 * reaches it and the loop ends. Resets are limited to one per node per 10min.
 */

import { getLogger } from '../logging/logger';
import { ConnectionFlapDetector } from './connection-flap-detector';

const logger = getLogger('WorkerNodeConnection');

export const FLAP_WINDOW_MS = 60_000;
export const FLAP_THRESHOLD = 10;
export const SLOW_FLAP_WINDOW_MS = 5 * 60_000;
export const SLOW_FLAP_THRESHOLD = 4;
export const FLAP_RESET_MIN_INTERVAL_MS = 10 * 60_000;
/** Application close code for a coordinator-initiated, non-revoking reset. */
export const CONNECTION_RESET_CLOSE_CODE = 4010;
export const FLAP_RESET_REASON = 'Flap reset';

export interface FlapStormEvent {
  nodeId: string;
  nodeName: string;
  replacesInWindow: number;
  windowMs: number;
}

export interface FlapObservation {
  /** Present only on the rising edge of a fast or slow storm. */
  storm?: FlapStormEvent;
  /** The caller should close the node's new active socket once registered. */
  resetConnection: boolean;
}

export interface WorkerConnectionFlapState {
  /** True while either rule considers the node to be storming. */
  stormActive: boolean;
  /** Live-socket replaces within the slow (5 minute) window. */
  replacesInWindow: number;
  windowMs: number;
  lastResetAt?: number;
}

export class WorkerConnectionFlapMonitor {
  private readonly fast = new ConnectionFlapDetector(FLAP_WINDOW_MS, FLAP_THRESHOLD);
  private readonly slow = new ConnectionFlapDetector(SLOW_FLAP_WINDOW_MS, SLOW_FLAP_THRESHOLD);
  private readonly epochs = new Map<string, number>();
  private readonly lastResetAt = new Map<string, number>();

  /**
   * Record a replace (`replacedLiveSocket`) or a re-register inside the
   * disconnect grace window. Only live-socket replaces count toward the slow
   * rule; a changed stream epoch means a new worker process and restarts it.
   */
  record(input: {
    nodeId: string;
    nodeName: string;
    now: number;
    replacedLiveSocket: boolean;
    streamEpoch?: unknown;
  }): FlapObservation {
    const { nodeId, nodeName, now } = input;
    const fast = this.fast.record(nodeId, now);
    const slow = input.replacedLiveSocket ? this.recordSlow(nodeId, now, input.streamEpoch) : undefined;
    let storm: FlapStormEvent | undefined;
    if (slow?.stormStarted) {
      storm = this.warn(nodeId, nodeName, slow.countInWindow, SLOW_FLAP_WINDOW_MS, 'slow');
    } else if (fast.stormStarted) {
      storm = this.warn(nodeId, nodeName, fast.countInWindow, FLAP_WINDOW_MS, 'fast');
    }
    if (!slow?.active) {
      return { ...(storm ? { storm } : {}), resetConnection: false };
    }

    // One reset per rate-limit interval while the slow storm persists: a reset
    // that did not end the loop gets another attempt, never a reset per cycle.
    const lastReset = this.lastResetAt.get(nodeId);
    if (lastReset !== undefined && now - lastReset < FLAP_RESET_MIN_INTERVAL_MS) {
      if (slow.stormStarted) {
        logger.warn('Worker node flap reset skipped — rate limited', {
          node: nodeName,
          nodeId,
          lastResetAgoMs: now - lastReset,
        });
      }
      return { ...(storm ? { storm } : {}), resetConnection: false };
    }
    this.lastResetAt.set(nodeId, now);
    logger.warn('Worker node flap reset — closing the new connection once after registration', {
      node: nodeName,
      nodeId,
      replacesInWindow: slow.countInWindow,
    });
    return { ...(storm ? { storm } : {}), resetConnection: true };
  }

  describe(nodeId: string, now: number): WorkerConnectionFlapState {
    const fast = this.fast.describe(nodeId, now);
    const slow = this.slow.describe(nodeId, now);
    const lastResetAt = this.lastResetAt.get(nodeId);
    return {
      stormActive: fast.active || slow.active,
      replacesInWindow: slow.countInWindow,
      windowMs: SLOW_FLAP_WINDOW_MS,
      ...(lastResetAt !== undefined ? { lastResetAt } : {}),
    };
  }

  clear(): void {
    this.fast.clear();
    this.slow.clear();
    this.epochs.clear();
    this.lastResetAt.clear();
  }

  private recordSlow(nodeId: string, now: number, streamEpoch: unknown) {
    if (typeof streamEpoch === 'number') {
      const previous = this.epochs.get(nodeId);
      if (previous !== undefined && previous !== streamEpoch) {
        this.slow.reset(nodeId);
      }
      this.epochs.set(nodeId, streamEpoch);
    }
    return this.slow.record(nodeId, now);
  }

  private warn(
    nodeId: string,
    nodeName: string,
    replacesInWindow: number,
    windowMs: number,
    rule: 'fast' | 'slow',
  ): FlapStormEvent {
    logger.warn('Worker node connection flap storm detected', {
      node: nodeName,
      nodeId,
      rule,
      replacesInWindow,
      windowMs,
    });
    return { nodeId, nodeName, replacesInWindow, windowMs };
  }
}
