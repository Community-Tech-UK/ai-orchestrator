import { randomUUID } from 'node:crypto';

export type BrowserExtensionCommandName =
  | 'open_tab'
  | 'navigate'
  | 'click'
  | 'type'
  | 'fill_form'
  | 'select'
  | 'snapshot'
  | 'screenshot'
  | 'wait_for';

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

export interface BrowserExtensionSendCommandRequest {
  command: BrowserExtensionCommandName;
  target?: BrowserExtensionCommandTarget;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface BrowserExtensionPollRequest {
  timeoutMs?: number;
}

export interface BrowserExtensionCommandResult {
  commandId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingCommand {
  command: BrowserExtensionQueuedCommand;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class BrowserExtensionCommandStore {
  private static instance: BrowserExtensionCommandStore | null = null;
  private readonly queue: BrowserExtensionQueuedCommand[] = [];
  private readonly pending = new Map<string, PendingCommand>();
  private readonly pollers: Array<(command: BrowserExtensionQueuedCommand | null) => void> = [];

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
        command,
        resolve,
        reject,
        timeout,
      });
      this.enqueue(command);
    });
  }

  pollCommand(request: BrowserExtensionPollRequest = {}): Promise<BrowserExtensionQueuedCommand | null> {
    const queued = this.queue.shift();
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
        const index = this.pollers.indexOf(poller);
        if (index >= 0) {
          this.pollers.splice(index, 1);
        }
        resolve(null);
      }, timeoutMs);
      this.pollers.push(poller);
    });
  }

  resolveCommand(result: BrowserExtensionCommandResult): void {
    const pending = this.pending.get(result.commandId);
    if (!pending) {
      return;
    }
    this.pending.delete(result.commandId);
    clearTimeout(pending.timeout);
    if (result.ok) {
      pending.resolve(result.result);
      return;
    }
    pending.reject(new Error(result.error || 'browser_extension_command_failed'));
  }

  private enqueue(command: BrowserExtensionQueuedCommand): void {
    const poller = this.pollers.shift();
    if (poller) {
      poller(command);
      return;
    }
    this.queue.push(command);
  }
}

export function getBrowserExtensionCommandStore(): BrowserExtensionCommandStore {
  return BrowserExtensionCommandStore.getInstance();
}
