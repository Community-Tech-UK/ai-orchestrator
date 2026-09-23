import type { AppServerNotification } from './app-server-types';

/**
 * Codex app-server compaction lifecycle, reduced to the two signals Harness acts on.
 *
 * Current Codex builds (verified live on codex-cli 0.156.1) report compaction
 * only as a `contextCompaction` thread item: `item/started` when the summary
 * request begins and `item/completed` when the thread has been replaced. The
 * legacy `thread/compacted` notification is deprecated in the generated
 * protocol and is no longer sent, so waiting on it alone made every native
 * compaction look unconfirmed (LT-017, LT-270).
 *
 * `started` means the provider is running a compaction. `completed` means it
 * finished. An older build could send both the legacy notification and the
 * completed item for one compaction, so completions are de-duplicated by turn id.
 */
export type CodexCompactionSignal = 'started' | 'completed';

export class CodexCompactionSignalTracker {
  private lastCompletedTurnId: string | null = null;

  /** Classifies a notification for `threadId`; null for anything unrelated or already counted. */
  accept(notification: AppServerNotification, threadId: string | null): CodexCompactionSignal | null {
    const { method, params } = notification;
    if (!threadId || params['threadId'] !== threadId) return null;

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

    if (signal === 'completed') {
      const turnId = typeof params['turnId'] === 'string' ? params['turnId'] : null;
      if (turnId && turnId === this.lastCompletedTurnId) return null;
      this.lastCompletedTurnId = turnId;
    }
    return signal;
  }
}
