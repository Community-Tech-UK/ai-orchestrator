/**
 * Pure classifiers for codex exec-mode failure handling. Kept out of the
 * adapter so the (already large) adapter file stays focused on process/IO
 * orchestration.
 */

import { CliSpawnCwdError } from '../base-cli-adapter-utils';

/**
 * Spawn-layer errno codes that can never succeed on retry: the binary is
 * missing (ENOENT from PATH lookup), not executable (EACCES/EPERM), or the
 * working directory is invalid (ENOENT/ENOTDIR from chdir).
 */
const FATAL_SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);

/**
 * True when the error is a process-spawn failure (missing binary, missing
 * cwd, non-executable binary). These are environmental and deterministic —
 * retrying the exact same spawn just doubles the user's wait — so the retry
 * loop must treat them as fatal and surface them immediately.
 */
export function isFatalSpawnError(error: unknown): boolean {
  if (error instanceof CliSpawnCwdError) {
    return true;
  }
  const err = error as NodeJS.ErrnoException | undefined;
  if (err?.code && FATAL_SPAWN_CODES.has(err.code) && err.syscall?.startsWith('spawn')) {
    return true;
  }
  // Fallback for errors that lost their errno shape through wrapping:
  return /spawn .+ (ENOENT|EACCES|EPERM|ENOTDIR)/.test(String(err?.message ?? error));
}

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

/**
 * True when codex rejected the turn because the assembled input payload
 * exceeds its per-turn character cap (currently 1 MiB / 1048576 chars). This is
 * distinct from a *token* context-window overflow: codex enforces a hard limit
 * on the raw character length of the request body it assembles from the full
 * thread (history + tool outputs + freshly-read file contents), and surfaces it
 * as e.g. "Input exceeds the maximum length of 1048576 characters."
 *
 * A session can hit this while still well under its token budget (e.g. after
 * reading several large files "in full" in one thread). The right recovery is a
 * native compaction (`thread/compact/start`) + one retry, not a raw surfaced
 * error — so this is classified separately from thread-loss and model errors.
 */
export function isCodexInputTooLargeError(error: unknown): boolean {
  const msg = String(error instanceof Error ? error.message : error).toLowerCase();
  return /input exceeds the maximum length of\s*[\d,]+\s*characters/.test(msg)
    || /exceeds the maximum length of\s*[\d,]+\s*characters/.test(msg);
}

/**
 * Classifies an error as a missing native Codex thread/session. Callers may
 * replay locally (exec mode), fall back during lifecycle recovery, or fail
 * closed when replay is unavailable (app-server mode). Requiring both thread
 * context and a loss indicator avoids matching an unrelated "not found".
 */
export function isRecoverableThreadResumeError(error: unknown): boolean {
  const msg = String(error instanceof Error ? error.message : error).toLowerCase();
  // If a Codex process is interrupted after emitting a custom_tool_call but
  // before its output is persisted, the native rollout cannot be resumed.
  // Treat that exact integrity diagnostic like a missing thread so exec mode
  // clears the poisoned resume id and performs its existing one-shot replay.
  if (/custom tool call output is missing for call id:\s*\S+/.test(msg)) return true;
  if (!/thread|session/.test(msg)) return false;
  return /not found|no rollout found|rollout not found|missing|no such|unknown|expired|invalid|does not exist/.test(msg);
}
