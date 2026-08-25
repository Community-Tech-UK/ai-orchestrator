import { randomUUID } from 'node:crypto';

export type BrowserExtensionCommandName =
  | 'open_tab'
  | 'navigate'
  | 'click'
  | 'type'
  | 'fill_form'
  | 'select'
  | 'upload_file'
  | 'download_file'
  | 'snapshot'
  | 'accessibility_snapshot'
  | 'screenshot'
  | 'console_messages'
  | 'network_requests'
  | 'wait_for'
  | 'query_elements'
  | 'read_control'
  | 'report_inventory'
  | 'evaluate';

export interface BrowserExtensionCommandTarget {
  profileId?: string;
  targetId?: string;
  tabId?: number;
  windowId?: number;
}

export interface BrowserExtensionQueuedCommand {
  id: string;
  command: BrowserExtensionCommandName;
  target?: BrowserExtensionCommandTarget;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  createdAt: number;
}

export type BrowserExtensionCommandQueueKey = string;

/**
 * Undelivered-wait budget that survives one extension channel gap. Chrome may
 * suspend the MV3 service worker (or the native host may drop) between polls;
 * the extension's own recovery alarm re-starts polling within ≤60s, plus poll
 * dispatch latency. Waiting 90s while a command is provably still queued turns
 * "browser_extension_command_timeout after 30s, twice, then it works" into a
 * single slower-but-successful call.
 */
export const BROWSER_EXTENSION_CHANNEL_RECOVERY_WAIT_MS = 90_000;

/**
 * How long a delivered command may go without a receipt ack before we conclude
 * the handoff failed (coordinator → relay → native host → extension). The hop
 * normally completes in well under a second; 15s tolerates a heavily loaded
 * coordinator without letting a genuinely lost handoff burn the whole
 * execution window. Only enforced on queues that have demonstrated receipt
 * support (self-calibrating — no version negotiation needed).
 */
export const BROWSER_EXTENSION_RECEIPT_WINDOW_MS = 15_000;

export function browserExtensionQueueKeyForNode(nodeId: string): BrowserExtensionCommandQueueKey {
  return `node:${nodeId}`;
}

export interface BrowserExtensionSendCommandRequest {
  queueKey?: BrowserExtensionCommandQueueKey;
  command: BrowserExtensionCommandName;
  target?: BrowserExtensionCommandTarget;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  executionTimeoutMs?: number;
  /**
   * How long the command may wait in the queue for an extension poller before
   * failing as `browser_extension_command_not_delivered`. Defaults to
   * `timeoutMs`. Set LARGER than `timeoutMs` to ride out a transient extension
   * channel gap (MV3 service-worker suspension recovers via a ≤60s alarm
   * cycle): while undelivered the command has provably not run, so waiting —
   * or retrying after `not_delivered` — is safe even for mutating commands.
   * Once delivered, the command gets its full `timeoutMs` execution window.
   */
  undeliveredWaitMs?: number;
  describeChannelState?: () => BrowserExtensionCommandChannelState;
}

export interface BrowserExtensionCommandChannelState {
  active: boolean;
  summary: string;
}

export interface BrowserExtensionQueueSnapshot {
  queueKey: BrowserExtensionCommandQueueKey;
  queuedCount: number;
  inFlightCount: number;
  waitingPollerCount: number;
}

export interface BrowserExtensionPollRequest {
  timeoutMs?: number;
  /** Remote relay polls wait for the RPC transport to confirm socket handoff. */
  deferHandoffConfirmation?: boolean;
}

export interface BrowserExtensionCommandResult {
  queueKey?: BrowserExtensionCommandQueueKey;
  commandId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingCommand {
  queueKey: BrowserExtensionCommandQueueKey;
  command: BrowserExtensionQueuedCommand;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  /** Full execution window granted once a poller picks the command up. */
  executionWindowMs: number;
  /** Absolute limit for safe delivery/re-delivery before extension execution. */
  undeliveredDeadlineAt: number;
  /** Set when a poller takes the command; undefined while still queued. */
  dequeuedAt?: number;
  /** Set when the extension acknowledges receiving the command. */
  receivedAt?: number;
  describeChannelState?: () => BrowserExtensionCommandChannelState;
}

interface CommandPoller {
  deferHandoffConfirmation: boolean;
  resolve: (command: BrowserExtensionQueuedCommand | null) => void;
}

export class BrowserExtensionCommandStore {
  private static instance: BrowserExtensionCommandStore | null = null;
  private readonly queues = new Map<BrowserExtensionCommandQueueKey, BrowserExtensionQueuedCommand[]>();
  private readonly pending = new Map<string, PendingCommand>();
  /**
   * Queues whose extension has ever sent a receipt ack. Receipt enforcement is
   * only applied to these — an older extension build that never acks must not
   * have every command rejected as receipt-missing.
   */
  private readonly receiptCapableQueues = new Set<BrowserExtensionCommandQueueKey>();
  private readonly pollers = new Map<BrowserExtensionCommandQueueKey, CommandPoller[]>();
  /** One remote command per queue may wait for its poll response socket handoff. */
  private readonly handoffPending = new Map<BrowserExtensionCommandQueueKey, string>();

  static getInstance(): BrowserExtensionCommandStore {
    if (!this.instance) {
      this.instance = new BrowserExtensionCommandStore();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  sendCommand(request: BrowserExtensionSendCommandRequest): Promise<unknown> {
    const queueKey = request.queueKey ?? 'local';
    const timeoutMs = request.timeoutMs ?? 30_000;
    const executionTimeoutMs = request.executionTimeoutMs ?? timeoutMs;
    const undeliveredWaitMs = request.undeliveredWaitMs ?? timeoutMs;
    const command: BrowserExtensionQueuedCommand = {
      id: randomUUID(),
      command: request.command,
      ...(request.target ? { target: request.target } : {}),
      ...(request.payload ? { payload: request.payload } : {}),
      ...(Number.isFinite(executionTimeoutMs) && executionTimeoutMs > 0
        ? { timeoutMs: Math.floor(executionTimeoutMs) }
        : {}),
      createdAt: Date.now(),
    };
    return new Promise<unknown>((resolve, reject) => {
      // Phase 1: wait for delivery. If no poller takes the command within the
      // undelivered budget, it is removed from the queue BEFORE rejecting, so a
      // `not_delivered` failure guarantees the command never ran — callers may
      // retry it safely, even mutations.
      const timeout = this.createUndeliveredTimeout(
        queueKey,
        command.id,
        reject,
        undeliveredWaitMs,
      );
      this.pending.set(command.id, {
        queueKey,
        command,
        resolve,
        reject,
        timeout,
        executionWindowMs: timeoutMs,
        undeliveredDeadlineAt: command.createdAt + undeliveredWaitMs,
        describeChannelState: request.describeChannelState,
      });
      this.enqueue(queueKey, command);
    });
  }

  pollCommand(request?: BrowserExtensionPollRequest): Promise<BrowserExtensionQueuedCommand | null>;
  pollCommand(
    queueKey: BrowserExtensionCommandQueueKey,
    request?: BrowserExtensionPollRequest,
  ): Promise<BrowserExtensionQueuedCommand | null>;
  pollCommand(
    queueKeyOrRequest: BrowserExtensionCommandQueueKey | BrowserExtensionPollRequest = 'local',
    maybeRequest: BrowserExtensionPollRequest = {},
  ): Promise<BrowserExtensionQueuedCommand | null> {
    const queueKey = typeof queueKeyOrRequest === 'string' ? queueKeyOrRequest : 'local';
    const request = typeof queueKeyOrRequest === 'string' ? maybeRequest : queueKeyOrRequest;
    const timeoutMs = Math.max(0, Math.min(request.timeoutMs ?? 1_000, 25_000));
    return new Promise<BrowserExtensionQueuedCommand | null>((resolve) => {
      let timeout: NodeJS.Timeout;
      const poller: CommandPoller = {
        deferHandoffConfirmation: request.deferHandoffConfirmation ?? false,
        resolve: (command) => {
          clearTimeout(timeout);
          resolve(command);
        },
      };
      timeout = setTimeout(() => {
        const pollers = this.pollersFor(queueKey);
        const index = pollers.indexOf(poller);
        if (index >= 0) {
          pollers.splice(index, 1);
        }
        resolve(null);
      }, timeoutMs);
      this.pollersFor(queueKey).push(poller);
      this.dispatchQueuedCommands(queueKey);
    });
  }

  confirmCommandHandoff(
    queueKey: BrowserExtensionCommandQueueKey,
    commandId: string,
  ): boolean {
    if (this.handoffPending.get(queueKey) !== commandId) {
      return false;
    }
    this.handoffPending.delete(queueKey);
    this.dispatchQueuedCommands(queueKey);
    return true;
  }

  resolveCommand(result: BrowserExtensionCommandResult): void {
    const pending = this.pending.get(result.commandId);
    if (!pending) {
      return;
    }
    const resultQueueKey = result.queueKey ?? 'local';
    if (resultQueueKey !== pending.queueKey) {
      throw new Error('browser_extension_command_queue_mismatch');
    }
    this.pending.delete(result.commandId);
    clearTimeout(pending.timeout);
    if (result.ok) {
      pending.resolve(result.result);
      return;
    }
    pending.reject(new Error(result.error || 'browser_extension_command_failed'));
  }

  /**
   * Return a command to its queue when the coordinator knows the poll RPC
   * response never reached an open node socket. This transition is safe only
   * before an extension receipt; all other delivered states are ambiguous and
   * must never be replayed.
   */
  requeueUndeliveredCommand(
    queueKey: BrowserExtensionCommandQueueKey,
    commandId: string,
  ): boolean {
    const pending = this.pending.get(commandId);
    if (
      !pending
      || pending.queueKey !== queueKey
      || pending.dequeuedAt === undefined
      || pending.receivedAt !== undefined
    ) {
      return false;
    }

    clearTimeout(pending.timeout);
    pending.dequeuedAt = undefined;
    if (this.handoffPending.get(queueKey) === commandId) {
      this.handoffPending.delete(queueKey);
    }
    const remainingMs = pending.undeliveredDeadlineAt - Date.now();
    if (remainingMs <= 0) {
      this.pending.delete(commandId);
      this.removeQueuedCommand(queueKey, commandId);
      pending.reject(new Error('browser_extension_command_not_delivered'));
      this.dispatchQueuedCommands(queueKey);
      return false;
    }

    pending.timeout = this.createUndeliveredTimeout(
      queueKey,
      commandId,
      pending.reject,
      remainingMs,
    );
    this.queueFor(queueKey).unshift(pending.command);
    this.dispatchQueuedCommands(queueKey);
    return true;
  }

  /** Point-in-time channel load for health/pre-flight reporting. */
  describeQueue(queueKey: BrowserExtensionCommandQueueKey): BrowserExtensionQueueSnapshot {
    let inFlightCount = 0;
    for (const pending of this.pending.values()) {
      if (pending.queueKey === queueKey && pending.dequeuedAt !== undefined) {
        inFlightCount += 1;
      }
    }
    return {
      queueKey,
      queuedCount: this.queues.get(queueKey)?.length ?? 0,
      inFlightCount,
      waitingPollerCount: this.pollers.get(queueKey)?.length ?? 0,
    };
  }

  rejectQueue(queueKey: BrowserExtensionCommandQueueKey, reason: string): void {
    this.queues.delete(queueKey);
    this.handoffPending.delete(queueKey);
    // A rejected queue usually means the node disconnected. The channel that
    // reconnects may be a different extension build, so receipt capability
    // must be re-proven rather than assumed.
    this.receiptCapableQueues.delete(queueKey);
    const pollers = this.pollers.get(queueKey);
    if (pollers) {
      this.pollers.delete(queueKey);
      for (const poller of pollers) {
        poller.resolve(null);
      }
    }
    for (const [commandId, pending] of this.pending.entries()) {
      if (pending.queueKey !== queueKey) {
        continue;
      }
      this.pending.delete(commandId);
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
  }

  private enqueue(
    queueKey: BrowserExtensionCommandQueueKey,
    command: BrowserExtensionQueuedCommand,
  ): void {
    this.queueFor(queueKey).push(command);
    this.dispatchQueuedCommands(queueKey);
  }

  private dispatchQueuedCommands(queueKey: BrowserExtensionCommandQueueKey): void {
    if (this.handoffPending.has(queueKey)) {
      return;
    }
    const queue = this.queueFor(queueKey);
    const pollers = this.pollersFor(queueKey);
    while (queue.length > 0 && pollers.length > 0) {
      const command = queue.shift()!;
      const poller = pollers.shift()!;
      this.markDelivered(command.id);
      if (poller.deferHandoffConfirmation) {
        this.handoffPending.set(queueKey, command.id);
      }
      poller.resolve(command);
      if (this.handoffPending.has(queueKey)) {
        return;
      }
    }
  }

  /**
   * Transition a pending command from "queued" to "delivered". On a
   * receipt-capable queue, "delivered" only means the poll RPC left the
   * coordinator — the handoff can still die at the relay, native host, or
   * extension port. A receipt watchdog therefore fires first: no ack within
   * the receipt window means the command almost certainly never reached the
   * extension. Once the receipt arrives (markReceived) the command gets its
   * full execution window, so late deliveries — e.g. after a service-worker
   * recovery — still have their whole budget to run.
   */
  private markDelivered(commandId: string): void {
    const pending = this.pending.get(commandId);
    if (!pending || pending.dequeuedAt !== undefined) {
      return;
    }
    pending.dequeuedAt = Date.now();
    clearTimeout(pending.timeout);
    // Defensive: today markDelivered always runs synchronously at handoff,
    // before the extension can possibly ack — but if that ordering ever
    // breaks, arming a receipt window after the receipt arrived would leave
    // the command with NO timer at all (the window's early-return on
    // receivedAt would fire with nothing re-armed → permanent hang).
    if (pending.receivedAt !== undefined) {
      this.armExecutionTimeout(pending, commandId);
      return;
    }
    if (this.receiptCapableQueues.has(pending.queueKey)) {
      pending.timeout = setTimeout(() => {
        if (pending.receivedAt !== undefined) {
          return;
        }
        this.pending.delete(commandId);
        pending.reject(new Error('browser_extension_command_receipt_missing'));
      }, Math.min(BROWSER_EXTENSION_RECEIPT_WINDOW_MS, pending.executionWindowMs));
      return;
    }
    this.armExecutionTimeout(pending, commandId);
  }

  /**
   * The extension acknowledged receiving a command. Registers the queue as
   * receipt-capable and upgrades the pending command's watchdog to the full
   * execution window. Capability is only learned from a receipt matching a
   * LIVE pending command on the same queue: a stale receipt straggling in
   * after rejectQueue() (node disconnect) belongs to the PREVIOUS channel,
   * and letting it re-register capability would falsely receipt-enforce a
   * reconnected channel that may run an older, receipt-less extension.
   */
  markReceived(queueKey: BrowserExtensionCommandQueueKey, commandId: string): void {
    const pending = this.pending.get(commandId);
    if (!pending || pending.queueKey !== queueKey) {
      return;
    }
    this.receiptCapableQueues.add(queueKey);
    if (pending.receivedAt !== undefined) {
      return;
    }
    pending.receivedAt = Date.now();
    clearTimeout(pending.timeout);
    this.armExecutionTimeout(pending, commandId);
  }

  private armExecutionTimeout(pending: PendingCommand, commandId: string): void {
    pending.timeout = setTimeout(() => {
      this.pending.delete(commandId);
      pending.reject(new Error(formatDeliveredCommandTimeout(pending.describeChannelState?.())));
    }, pending.executionWindowMs);
  }

  private createUndeliveredTimeout(
    queueKey: BrowserExtensionCommandQueueKey,
    commandId: string,
    reject: (error: Error) => void,
    delayMs: number,
  ): NodeJS.Timeout {
    return setTimeout(() => {
      this.pending.delete(commandId);
      this.removeQueuedCommand(queueKey, commandId);
      reject(new Error('browser_extension_command_not_delivered'));
    }, delayMs);
  }

  private removeQueuedCommand(
    queueKey: BrowserExtensionCommandQueueKey,
    commandId: string,
  ): void {
    const queue = this.queues.get(queueKey);
    if (!queue) {
      return;
    }
    const index = queue.findIndex((command) => command.id === commandId);
    if (index >= 0) {
      queue.splice(index, 1);
    }
    if (queue.length === 0) {
      this.queues.delete(queueKey);
    }
  }

  private queueFor(queueKey: BrowserExtensionCommandQueueKey): BrowserExtensionQueuedCommand[] {
    let queue = this.queues.get(queueKey);
    if (!queue) {
      queue = [];
      this.queues.set(queueKey, queue);
    }
    return queue;
  }

  private pollersFor(
    queueKey: BrowserExtensionCommandQueueKey,
  ): CommandPoller[] {
    let pollers = this.pollers.get(queueKey);
    if (!pollers) {
      pollers = [];
      this.pollers.set(queueKey, pollers);
    }
    return pollers;
  }
}

function formatDeliveredCommandTimeout(
  channelState: BrowserExtensionCommandChannelState | undefined,
): string {
  if (!channelState) {
    return 'browser_extension_command_timeout';
  }
  if (!channelState.active) {
    return `browser_extension_channel_down (${channelState.summary})`;
  }
  return `browser_extension_command_timeout (channel active - command not answered; ${channelState.summary})`;
}

export function getBrowserExtensionCommandStore(): BrowserExtensionCommandStore {
  return BrowserExtensionCommandStore.getInstance();
}
