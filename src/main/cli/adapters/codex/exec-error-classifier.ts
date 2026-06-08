/**
 * Pure classifiers for codex exec-mode failure handling. Kept out of the
 * adapter so the (already large) adapter file stays focused on process/IO
 * orchestration.
 */

/**
 * Codex prints "Reading prompt from stdin..." to stderr on every exec turn
 * (it reads the prompt from stdin rather than a positional arg). It is purely
 * informational — never an error — so it must never be surfaced as the reason a
 * turn failed. Real failures are emitted as `error`/`turn.failed` events on
 * stdout.
 */
export function isBenignCodexStdinNotice(line: string): boolean {
  return /^reading prompt from stdin\b/i.test(line.trim());
}

/**
 * True when codex rejected the request because the requested model is not
 * available for the active account/CLI (vs. a transient network/backend error).
 *
 * The common trigger: the orchestrator's static model catalog routes a turn to
 * a model id the signed-in account doesn't offer — e.g. a `*-codex` id under
 * ChatGPT-account auth, which codex rejects with
 * "... is not supported when using Codex with a ChatGPT account." Used to
 * trigger a one-shot fallback to codex's own default model.
 */
export function isCodexModelUnavailableError(error: unknown): boolean {
  const msg = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    /not supported when using codex/.test(msg) ||
    /model is not supported/.test(msg) ||
    /unsupported model/.test(msg) ||
    /unknown model/.test(msg) ||
    /model not found/.test(msg) ||
    /invalid model/.test(msg) ||
    /\bmodel\b[^.]*\bnot available\b/.test(msg)
  );
}
