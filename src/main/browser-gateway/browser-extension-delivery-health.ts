import {
  POST_DELIVERY_UNANSWERED_MIN,
  type BrowserDeliveryHealth,
} from './browser-worker-agent-skew';

/**
 * Rolling answered/unanswered record for commands that were successfully
 * DELIVERED to an extension channel.
 *
 * Deliberately separate from the command store's pre-delivery outcomes, which
 * answer a different question. Pre-delivery asks "can we hand a command off?";
 * this asks "does anything actually run?". An MV3 service worker can keep its
 * long-poll loop alive after the half that executes commands has died, so every
 * delivery-side signal stays green while nothing works — windows-pc spent 9.3h
 * in exactly that state on 2026-09-20, reported as `commandsDeliverable: true`.
 */
export interface BrowserExtensionDeliveryOutcome {
  answered: boolean;
  at: number;
  reason?: string;
}

const POST_DELIVERY_WINDOW = 5;

export class BrowserExtensionDeliveryHealthTracker<TQueueKey> {
  private readonly outcomes = new Map<TQueueKey, BrowserExtensionDeliveryOutcome[]>();

  record(queueKey: TQueueKey, outcome: BrowserExtensionDeliveryOutcome): void {
    const recent = this.outcomes.get(queueKey) ?? [];
    recent.push(outcome);
    if (recent.length > POST_DELIVERY_WINDOW) {
      recent.shift();
    }
    this.outcomes.set(queueKey, recent);
  }

  /**
   * An empty window reports healthy: a channel nobody has asked to do anything
   * is not evidence of a fault, and reporting one would flip every idle node to
   * broken the moment it connected.
   */
  describe(queueKey: TQueueKey): BrowserDeliveryHealth {
    const recent = this.outcomes.get(queueKey) ?? [];
    let consecutiveUnanswered = 0;
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      if (recent[index]?.answered !== false) break;
      consecutiveUnanswered += 1;
    }
    const last = recent.at(-1);
    const unanswered = consecutiveUnanswered >= POST_DELIVERY_UNANSWERED_MIN;
    return {
      commandsAnswered: !unanswered,
      consecutiveUnanswered,
      ...(unanswered && last?.at !== undefined ? { lastUnansweredAt: last.at } : {}),
      ...(unanswered && last?.reason ? { lastReason: last.reason } : {}),
    };
  }

  /**
   * Drop a channel's history — after a recovery attempt actually succeeds, or
   * when the queue is rejected and the channel that reconnects is a new one.
   * Either way the channel is judged on what it does NEXT rather than staying
   * condemned by the timeouts that preceded it.
   */
  clear(queueKey: TQueueKey): void {
    this.outcomes.delete(queueKey);
  }
}
