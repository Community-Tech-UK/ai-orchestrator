import { pollerServesCommandInstance, type CommandPoller } from './browser-extension-command-delivery';
import type {
  BrowserExtensionCommandQueueKey,
  BrowserExtensionCommandStore,
  BrowserExtensionQueuedCommand,
  BrowserExtensionSendCommandRequest,
} from './browser-extension-command-store';

/**
 * Routing for several extension installs (one per Chrome profile) sharing one
 * machine's command queue. Before install ids every profile long-polled the
 * same queue and took any command, so a command for one profile's tab ran in
 * another profile, and profile-wide commands reached only one profile.
 */

/**
 * An extension install counts as present on a queue while it has polled this
 * recently. A live install re-polls within ~10s (long-poll window) plus a
 * 250ms idle gap, so 30s tolerates a slow coordinator without keeping a
 * closed Chrome profile in fan-outs for long.
 */
export const BROWSER_EXTENSION_INSTANCE_RECENT_MS = 30_000;

interface InstancePoll {
  at: number;
  /** Whether that poll could take browser commands. */
  capable: boolean;
}

/** Last poll of each extension install, per queue. */
export class ExtensionInstancePollTracker {
  private readonly pollsByQueue = new Map<BrowserExtensionCommandQueueKey, Map<string, InstancePoll>>();

  record(
    queueKey: BrowserExtensionCommandQueueKey,
    instanceId: string,
    capable: boolean,
    now = Date.now(),
  ): void {
    let polls = this.pollsByQueue.get(queueKey);
    if (!polls) {
      polls = new Map<string, InstancePoll>();
      this.pollsByQueue.set(queueKey, polls);
    }
    polls.set(instanceId, { at: now, capable });
  }

  /** True when an install other than `instanceId` recently polled able to take commands. */
  hasRecentCapableOther(
    queueKey: BrowserExtensionCommandQueueKey,
    instanceId: string | undefined,
    now = Date.now(),
  ): boolean {
    for (const [otherId, poll] of this.pollsByQueue.get(queueKey) ?? []) {
      if (otherId !== instanceId && poll.capable && now - poll.at <= BROWSER_EXTENSION_INSTANCE_RECENT_MS) {
        return true;
      }
    }
    return false;
  }

  listRecent(
    queueKey: BrowserExtensionCommandQueueKey,
    withinMs = BROWSER_EXTENSION_INSTANCE_RECENT_MS,
    now = Date.now(),
  ): string[] {
    const polls = this.pollsByQueue.get(queueKey);
    if (!polls) {
      return [];
    }
    const recent: string[] = [];
    for (const [instanceId, { at: polledAt }] of polls.entries()) {
      if (now - polledAt <= withinMs) {
        recent.push(instanceId);
      } else if (now - polledAt > BROWSER_EXTENSION_INSTANCE_RECENT_MS) {
        polls.delete(instanceId);
      }
    }
    if (polls.size === 0) {
      this.pollsByQueue.delete(queueKey);
    }
    return recent;
  }

  forget(queueKey: BrowserExtensionCommandQueueKey): void {
    this.pollsByQueue.delete(queueKey);
  }
}

export interface ExtensionCommandDispatch {
  command: BrowserExtensionQueuedCommand;
  pollerIndex: number;
  capable: boolean;
}

/**
 * The first queued command some waiting poll may serve. Only polls from the
 * install a command is bound to are eligible for it, so a command for one
 * Chrome profile neither goes to another profile nor blocks the commands
 * queued behind it while its own profile's poll is in flight. Among eligible
 * polls a capable one is preferred; when every eligible poll is incapable
 * the command is refused through the first of them, as before install ids —
 * unless `mayRefuse` says to wait: an unbound command (`open_tab`) must not
 * be refused by an outdated profile while a working profile is between polls.
 */
export function selectNextCommandDispatch(
  queue: readonly BrowserExtensionQueuedCommand[],
  pollers: readonly CommandPoller[],
  canDeliver: (poller: CommandPoller, command: BrowserExtensionQueuedCommand) => boolean,
  mayRefuse: (poller: CommandPoller, command: BrowserExtensionQueuedCommand) => boolean = () => true,
): ExtensionCommandDispatch | null {
  for (const command of queue) {
    let firstEligible = -1;
    for (let index = 0; index < pollers.length; index += 1) {
      const poller = pollers[index]!;
      if (!pollerServesCommandInstance(poller, command)) {
        continue;
      }
      if (canDeliver(poller, command)) {
        return { command, pollerIndex: index, capable: true };
      }
      if (firstEligible < 0) {
        firstEligible = index;
      }
    }
    if (firstEligible >= 0 && mayRefuse(pollers[firstEligible]!, command)) {
      return { command, pollerIndex: firstEligible, capable: false };
    }
  }
  return null;
}

/**
 * Send an unbound, profile-wide command (inventory report, protection push)
 * to every Chrome profile polling the queue. Unbound, it would reach only
 * whichever profile polled first. With zero or one recent install it is sent
 * once, unbound, exactly as before install ids. Per-install copies only wait
 * `timeoutMs` for delivery: each install was seen polling moments ago, and a
 * profile closed since then must not stall the others' answers.
 */
export async function sendCommandToEachExtensionInstance(
  store: Pick<BrowserExtensionCommandStore, 'sendCommand'>
    & Partial<Pick<BrowserExtensionCommandStore, 'listRecentExtensionInstances'>>,
  request: BrowserExtensionSendCommandRequest & { queueKey: BrowserExtensionCommandQueueKey },
): Promise<PromiseSettledResult<unknown>[]> {
  const instances = store.listRecentExtensionInstances?.(request.queueKey) ?? [];
  if (instances.length <= 1) {
    return Promise.allSettled([store.sendCommand(request)]);
  }
  const deliveryWaitMs = request.timeoutMs ?? 30_000;
  return Promise.allSettled(instances.map((extensionInstanceId) => store.sendCommand({
    ...request,
    target: { ...request.target, extensionInstanceId },
    undeliveredWaitMs: Math.min(request.undeliveredWaitMs ?? deliveryWaitMs, deliveryWaitMs),
  })));
}
