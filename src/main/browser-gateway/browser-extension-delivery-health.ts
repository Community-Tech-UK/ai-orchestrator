import {
  POST_DELIVERY_UNANSWERED_MIN,
  PRE_DELIVERY_INCAPABLE_MIN,
  type BrowserDeliveryHealth,
  type BrowserPreDeliveryCapability,
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

function describeHistory(recent: readonly BrowserExtensionDeliveryOutcome[]): BrowserDeliveryHealth {
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
 * History is kept per extension install (Chrome profile) on the queue, keyed
 * '' for builds that report no install id. One profile whose service worker
 * polls but no longer executes must not mark a healthy profile on the same
 * machine as unanswered.
 */
export class BrowserExtensionDeliveryHealthTracker<TQueueKey> {
  private readonly outcomes = new Map<TQueueKey, Map<string, BrowserExtensionDeliveryOutcome[]>>();

  record(
    queueKey: TQueueKey,
    outcome: BrowserExtensionDeliveryOutcome,
    extensionInstanceId?: string,
  ): void {
    let byInstance = this.outcomes.get(queueKey);
    if (!byInstance) {
      byInstance = new Map<string, BrowserExtensionDeliveryOutcome[]>();
      this.outcomes.set(queueKey, byInstance);
    }
    const recent = byInstance.get(extensionInstanceId ?? '') ?? [];
    recent.push(outcome);
    if (recent.length > POST_DELIVERY_WINDOW) {
      recent.shift();
    }
    byInstance.set(extensionInstanceId ?? '', recent);
  }

  /**
   * With an install id: that Chrome profile's own history. Without one: the
   * queue is unanswered only when every profile with history is, so a single
   * answering profile keeps the machine usable.
   *
   * An empty window reports healthy: a channel nobody has asked to do anything
   * is not evidence of a fault, and reporting one would flip every idle node to
   * broken the moment it connected.
   */
  describe(queueKey: TQueueKey, extensionInstanceId?: string): BrowserDeliveryHealth {
    const byInstance = this.outcomes.get(queueKey);
    if (extensionInstanceId !== undefined || !byInstance || byInstance.size <= 1) {
      return describeHistory(
        extensionInstanceId !== undefined
          ? byInstance?.get(extensionInstanceId) ?? []
          : [...(byInstance?.values() ?? [])][0] ?? [],
      );
    }
    const described = [...byInstance.values()].map(describeHistory);
    return described.find((health) => health.commandsAnswered) ?? described[0]!;
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

interface PreDeliveryOutcome {
  delivered: boolean;
  reason?: string;
}

const PRE_DELIVERY_WINDOW = 5;

/**
 * Rolling handed-off/refused record per queue: "can we hand a command off at
 * all?". Every recent attempt refused before delivery means the channel's
 * polls cannot take commands (an incompatible runtime, for example).
 */
export class BrowserExtensionPreDeliveryTracker<TQueueKey> {
  private readonly outcomes = new Map<TQueueKey, PreDeliveryOutcome[]>();

  record(queueKey: TQueueKey, outcome: PreDeliveryOutcome): void {
    const recent = this.outcomes.get(queueKey) ?? [];
    recent.push(outcome);
    if (recent.length > PRE_DELIVERY_WINDOW) {
      recent.shift();
    }
    this.outcomes.set(queueKey, recent);
  }

  describe(queueKey: TQueueKey): BrowserPreDeliveryCapability {
    const recent = this.outcomes.get(queueKey) ?? [];
    const rejections = recent.filter((outcome) => !outcome.delivered);
    const allRejected = recent.length >= PRE_DELIVERY_INCAPABLE_MIN
      && rejections.length === recent.length;
    const lastReason = rejections.at(-1)?.reason;
    return {
      commandsDeliverable: !allRejected,
      ...(allRejected && lastReason ? { reason: lastReason } : {}),
    };
  }

  clear(queueKey: TQueueKey): void {
    this.outcomes.delete(queueKey);
  }
}
