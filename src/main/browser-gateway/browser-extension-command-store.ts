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
  | 'wait_for'
  | 'query_elements'
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
  createdAt: number;
}

export type BrowserExtensionCommandQueueKey = string;

export function browserExtensionQueueKeyForNode(nodeId: string): BrowserExtensionCommandQueueKey {
  return `node:${nodeId}`;
}

export interface BrowserExtensionSendCommandRequest {
  queueKey?: BrowserExtensionCommandQueueKey;
  command: BrowserExtensionCommandName;
  target?: BrowserExtensionCommandTarget;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface BrowserExtensionPollRequest {
  timeoutMs?: number;
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
}

export class BrowserExtensionCommandStore {
  private static instance: BrowserExtensionCommandStore | null = null;
  private readonly queues = new Map<BrowserExtensionCommandQueueKey, BrowserExtensionQueuedCommand[]>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly pollers = new Map<
    BrowserExtensionCommandQueueKey,
    Array<(command: BrowserExtensionQueuedCommand | null) => void>
  >();

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
    const command: BrowserExtensionQueuedCommand = {
      id: randomUUID(),
      command: request.command,
      ...(request.target ? { target: request.target } : {}),
      ...(request.payload ? { payload: request.payload } : {}),
      createdAt: Date.now(),
    };
    const timeoutMs = request.timeoutMs ?? 30_000;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error('browser_extension_command_timeout'));
      }, timeoutMs);
      this.pending.set(command.id, {
        queueKey,
        command,
        resolve,
        reject,
        timeout,
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
    const queued = this.queueFor(queueKey).shift();
    if (queued) {
      return Promise.resolve(queued);
    }

    const timeoutMs = Math.max(0, Math.min(request.timeoutMs ?? 1_000, 25_000));
    return new Promise<BrowserExtensionQueuedCommand | null>((resolve) => {
      const poller = (command: BrowserExtensionQueuedCommand | null): void => {
        clearTimeout(timeout);
        resolve(command);
      };
      const timeout = setTimeout(() => {
        const pollers = this.pollersFor(queueKey);
        const index = pollers.indexOf(poller);
        if (index >= 0) {
          pollers.splice(index, 1);
        }
        resolve(null);
      }, timeoutMs);
      this.pollersFor(queueKey).push(poller);
    });
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

  rejectQueue(queueKey: BrowserExtensionCommandQueueKey, reason: string): void {
    this.queues.delete(queueKey);
    const pollers = this.pollers.get(queueKey);
    if (pollers) {
      this.pollers.delete(queueKey);
      for (const poller of pollers) {
        poller(null);
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
    const poller = this.pollersFor(queueKey).shift();
    if (poller) {
      poller(command);
      return;
    }
    this.queueFor(queueKey).push(command);
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
  ): Array<(command: BrowserExtensionQueuedCommand | null) => void> {
    let pollers = this.pollers.get(queueKey);
    if (!pollers) {
      pollers = [];
      this.pollers.set(queueKey, pollers);
    }
    return pollers;
  }
}

export function getBrowserExtensionCommandStore(): BrowserExtensionCommandStore {
  return BrowserExtensionCommandStore.getInstance();
}
