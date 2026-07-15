import { isCodexInputTooLargeError } from './exec-error-classifier';

/**
 * Operations the {@link recoverFromInputCap} ladder drives, injected by the
 * adapter so the recovery logic stays pure and unit-testable.
 */
export interface InputCapRecoveryOps {
  /** Send the pending turn against the current app-server thread. */
  send(): Promise<void>;
  /** Compact the current thread; true means `thread/compacted` was observed. */
  compact(): Promise<boolean>;
  /** Reopen a fresh thread — clears server-side context. */
  reopenThread(): Promise<void>;
  /** Notify the user, transparently, that the thread was reset. */
  onThreadReset(): void;
}

/**
 * Recovers a turn Codex rejected for exceeding its per-turn input *character*
 * cap (~1 MiB on the assembled body of history + tool outputs + file contents,
 * separate from the token window). Escalates along a ladder that survives
 * rather than dead-ends:
 *
 *   1. Compact and require proof that it landed, then retry once — preserves context via
 *      Codex's own summarization.
 *   2. If a single oversized item still overflows (compaction can only trim
 *      history, not shrink one huge file dump), or compaction was unavailable,
 *      reopen a fresh thread and retry once — loses context, but the session
 *      survives and the user's message goes through.
 *   3. Only if the user's *own* message overflows a fresh thread is the message
 *      itself the problem — surface a clear, actionable error.
 *
 * Non-cap errors from any retry propagate unchanged.
 */
export async function recoverFromInputCap(ops: InputCapRecoveryOps): Promise<void> {
  if (await ops.compact()) {
    try {
      await ops.send();
      return;
    } catch (retryErr) {
      if (!isCodexInputTooLargeError(retryErr)) throw retryErr;
      // Compaction could not fit the turn — fall through to a fresh thread.
    }
  }

  await ops.reopenThread();
  ops.onThreadReset();
  try {
    await ops.send();
  } catch (freshErr) {
    if (isCodexInputTooLargeError(freshErr)) {
      throw new Error(
        'Codex rejected the turn: your message exceeds Codex’s per-turn size limit even on a fresh thread. Reduce the message itself (e.g. attach fewer or smaller files) and retry.',
      );
    }
    throw freshErr;
  }
}
