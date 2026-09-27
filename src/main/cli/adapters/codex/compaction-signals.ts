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
export type CodexCompactionSignal =
  | 'started'
  | 'inline-started'
  | 'completed'
  | 'observed-running'
  | 'settled'
  | 'aborted';

export class CodexCompactionSignalTracker {
  private lastCompletedTurnId: string | null = null;
  private running = false;
  private runningTurnIdValue: string | null = null;
  private runningInferredFromRejection = false;
  private runningCompletionObserved = false;
  private suppressLegacyCompletionWithoutTurnId = false;
  private readonly completedInlineItemIds = new Set<string>();

  /** Whether Codex currently owns the thread for a provider compaction turn. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Turn id of the compaction the provider is running now, when it reported one. */
  get runningTurnId(): string | null {
    return this.running ? this.runningTurnIdValue : null;
  }

  /**
   * Classifies a notification for `threadId`; null for anything unrelated or
   * already counted. `inlineTurnId` is the running regular turn when Harness
   * has not asked for a compaction: Codex's own compaction runs inside that
   * turn, which stays steerable once the item completes, so it opens no
   * compaction gate (`inline-started`, then `completed`).
   */
  accept(
    notification: AppServerNotification,
    threadId: string | null,
    inlineTurnId: string | null = null,
  ): CodexCompactionSignal | null {
    const { method, params } = notification;
    if (!threadId || params['threadId'] !== threadId) return null;
    const turnId = typeof params['turnId'] === 'string' ? params['turnId'] : null;
    const inlineSignal = this.acceptInline(method, params, turnId, inlineTurnId);
    if (inlineSignal !== undefined) return inlineSignal;

    if (method === 'turn/completed') {
      if (!this.running) return null;
      const turn = params['turn'] as { id?: unknown } | undefined;
      if (this.runningTurnIdValue && turn?.id !== this.runningTurnIdValue) return null;
      const inferred = this.runningInferredFromRejection;
      const observed = this.runningCompletionObserved;
      this.resetRunningState();
      return inferred || observed ? 'settled' : 'aborted';
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
      this.suppressLegacyCompletionWithoutTurnId = false;
      if (this.running) {
        if (!this.runningTurnIdValue && turnId) this.runningTurnIdValue = turnId;
        return null;
      }
      this.running = true;
      this.runningTurnIdValue = turnId;
      this.runningInferredFromRejection = false;
      return signal;
    }
    if (method === 'thread/compacted' && !turnId && this.suppressLegacyCompletionWithoutTurnId) {
      this.suppressLegacyCompletionWithoutTurnId = false;
      return null;
    }
    if (this.running && this.runningTurnIdValue && turnId && this.runningTurnIdValue !== turnId) return null;
    if (turnId && turnId === this.lastCompletedTurnId) return null;
    if (method === 'item/completed') this.suppressLegacyCompletionWithoutTurnId = true;
    this.lastCompletedTurnId = turnId;
    if (this.running) {
      if (!this.runningTurnIdValue && turnId) this.runningTurnIdValue = turnId;
      if (!this.runningTurnIdValue || !turnId || this.runningTurnIdValue === turnId) {
        this.runningCompletionObserved = true;
        return 'observed-running';
      }
    }
    this.resetRunningState();
    return signal;
  }

  /** Returns undefined when the notification is not an inline compaction item. */
  private acceptInline(
    method: string,
    params: Record<string, unknown>,
    turnId: string | null,
    inlineTurnId: string | null,
  ): CodexCompactionSignal | null | undefined {
    if (this.running || !inlineTurnId || turnId !== inlineTurnId) return undefined;
    if (method !== 'item/started' && method !== 'item/completed') return undefined;
    const item = params['item'] as { type?: unknown; id?: unknown } | undefined;
    if (item?.type !== 'contextCompaction') return undefined;
    if (method === 'item/started') return 'inline-started';
    // One turn can compact more than once, so inline completions de-duplicate by item id.
    const itemId = typeof item.id === 'string' ? item.id : null;
    if (itemId) {
      if (this.completedInlineItemIds.has(itemId)) return null;
      this.completedInlineItemIds.add(itemId);
    }
    this.lastCompletedTurnId = turnId;
    this.suppressLegacyCompletionWithoutTurnId = true;
    return 'completed';
  }

  /** Records the provider-owned compact turn exposed by a strict send rejection. */
  markRunningFromRejection(turnId: string | null): void {
    this.running = true;
    this.runningTurnIdValue = turnId;
    this.runningInferredFromRejection = true;
    this.runningCompletionObserved = false;
  }

  /** Forgets a running compaction, e.g. when the app-server process is gone. */
  reset(): void {
    this.resetRunningState();
    this.completedInlineItemIds.clear();
    this.lastCompletedTurnId = null;
    this.suppressLegacyCompletionWithoutTurnId = false;
  }

  private resetRunningState(): void {
    this.running = false;
    this.runningTurnIdValue = null;
    this.runningInferredFromRejection = false;
    this.runningCompletionObserved = false;
  }
}
