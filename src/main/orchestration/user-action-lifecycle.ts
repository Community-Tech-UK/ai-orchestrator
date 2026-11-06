/**
 * Everything an orchestrator card goes through between being raised and being
 * closed: the request, its timer, and the one place it can end.
 *
 * Before this, a card could end four ways with four different amounts of
 * ceremony: an answer cleared its waiter, a timeout deleted the request in
 * silence, a stopped session left it standing, and a reply to a request that no
 * longer existed was reported as a success. Every ending now goes through
 * `settle`, which closes the request exactly once, stops its timer, lets an
 * in-process waiter carry on and then announces how it ended. A second ending
 * for the same request finds nothing to close and is told so.
 */

import { getLogger } from '../logging/logger';
import type { UserActionRequest } from './orchestration-handler.types';

const logger = getLogger('UserActionLifecycle');

/**
 * Where an answer came from. `window` is this app's own window (the card, the
 * workboard); `typed-reply` is a reply typed in the message box and read in main;
 * anything else (phone, chat channel, thin client) is `elsewhere`.
 */
export type UserActionChannel = 'window' | 'typed-reply' | 'elsewhere';

/** How a request ended. */
export type UserActionEnd =
  | { reason: 'decided'; approved: boolean; selectedOption?: string; via: UserActionChannel }
  | { reason: 'timeout' }
  /** The turn was stopped. */
  | { reason: 'cancelled' }
  /** The session closed. */
  | { reason: 'exited' };

export interface SettledUserAction {
  request: UserActionRequest;
  /** How long the request was open, in milliseconds. */
  waitedMs: number;
  end: UserActionEnd;
}

export interface OpenUserActionOptions {
  /** Close the request as timed out after this long. Omit for a request that waits for as long as it takes. */
  timeoutMs?: number;
  /** Called once, with how the request ended, before it is announced. */
  onSettled?: (settled: SettledUserAction) => void;
}

interface Entry {
  request: UserActionRequest;
  openedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  onSettled?: (settled: SettledUserAction) => void;
}

export class UserActionLifecycle {
  private readonly entries = new Map<string, Entry>();

  /** `announce` is told about every ending, after the request has already been closed. */
  constructor(private readonly announce: (settled: SettledUserAction) => void) {}

  open(request: UserActionRequest, options: OpenUserActionOptions = {}): void {
    const entry: Entry = { request, openedAt: Date.now(), onSettled: options.onSettled };
    if (options.timeoutMs !== undefined) {
      entry.timer = setTimeout(() => this.settle(request.id, { reason: 'timeout' }), options.timeoutMs);
      entry.timer.unref?.();
    }
    this.entries.set(request.id, entry);
  }

  get(requestId: string): UserActionRequest | undefined {
    return this.entries.get(requestId)?.request;
  }

  list(): UserActionRequest[] {
    return Array.from(this.entries.values(), (entry) => entry.request);
  }

  listForInstance(instanceId: string): UserActionRequest[] {
    return this.list().filter((request) => request.instanceId === instanceId);
  }

  /**
   * Closes a request, whichever way it ended. Returns what was closed, or null
   * when there is nothing to close: it already ended, or never existed.
   */
  settle(requestId: string, end: UserActionEnd): SettledUserAction | null {
    const entry = this.entries.get(requestId);
    if (!entry) return null;
    this.entries.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    const settled: SettledUserAction = { request: entry.request, waitedMs: Date.now() - entry.openedAt, end };
    // A listener that throws must not leave the request half closed or stop the others.
    this.guarded('waiter', requestId, () => entry.onSettled?.(settled));
    this.guarded('listener', requestId, () => this.announce(settled));
    return settled;
  }

  /** Closes every request of a session, or only those `matching` accepts. Returns how many closed. */
  settleForInstance(
    instanceId: string,
    end: Exclude<UserActionEnd, { reason: 'decided' }>,
    matching: (request: UserActionRequest) => boolean = () => true,
  ): number {
    let closed = 0;
    for (const request of this.listForInstance(instanceId)) {
      if (matching(request) && this.settle(request.id, end)) closed += 1;
    }
    return closed;
  }

  /** Ends everything still open as exited and stops every timer. */
  dispose(): void {
    for (const request of this.list()) this.settle(request.id, { reason: 'exited' });
  }

  private guarded(what: string, requestId: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      logger.warn(`User action ${what} threw while closing a request`, {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
