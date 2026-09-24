import type { AppServerNotification } from './app-server-types';

/**
 * Codex app-server compaction lifecycle, reduced to the signals Harness acts on.
 *
 * Current Codex builds (verified live on codex-cli 0.156.1) report compaction
 * only as a `contextCompaction` thread item: `item/started` when the summary
 * request begins and `item/completed` when the thread has been replaced. The
 * legacy `thread/compacted` notification is deprecated in the generated
 * protocol and is no longer sent, so waiting on it alone made every native
 * compaction look unconfirmed (LT-017, LT-270).
 *
 * `started` means the provider is running a compaction. `completed` means it
 * finished. `aborted` means the turn that was running it ended (interrupted or
 * failed) without the compaction completing, so nothing more will arrive for
 * it. An older build could send both the legacy notification and the
 * completed item for one compaction, so completions are de-duplicated by turn id.
 */
export type CodexCompactionSignal = 'started' | 'completed' | 'aborted';

export class CodexCompactionSignalTracker {
  private lastCompletedTurnId: string | null = null;
  private running = false;
  private runningTurnIdValue: string | null = null;

  /** Turn id of the compaction the provider is running now, when it reported one. */
  get runningTurnId(): string | null {
    return this.running ? this.runningTurnIdValue : null;
  }

  /** Classifies a notification for `threadId`; null for anything unrelated or already counted. */
  accept(notification: AppServerNotification, threadId: string | null): CodexCompactionSignal | null {
    const { method, params } = notification;
    if (!threadId || params['threadId'] !== threadId) return null;
    const turnId = typeof params['turnId'] === 'string' ? params['turnId'] : null;

    if (method === 'turn/completed') {
      if (!this.running) return null;
      const turn = params['turn'] as { id?: unknown } | undefined;
      if (this.runningTurnIdValue && turn?.id !== this.runningTurnIdValue) return null;
      this.reset();
      return 'aborted';
    }

    let signal: CodexCompactionSignal;
    if (method === 'thread/compacted') {
      signal = 'completed';
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = params['item'] as { type?: unknown } | undefined;
      if (item?.type !== 'contextCompaction') return null;
      signal = method === 'item/started' ? 'started' : 'completed';
    } else {
      return null;
    }

    if (signal === 'started') {
      this.running = true;
      this.runningTurnIdValue = turnId;
      return signal;
    }
    this.reset();
    if (turnId && turnId === this.lastCompletedTurnId) return null;
    this.lastCompletedTurnId = turnId;
    return signal;
  }

  /** Forgets a running compaction, e.g. when the app-server process is gone. */
  reset(): void {
    this.running = false;
    this.runningTurnIdValue = null;
  }
}
