/**
 * progress-draft-compositor.ts
 *
 * Pure text-composition helpers for WS-C8 editable channel progress drafts.
 * Given typed status updates (a phase/detail line + elapsed time), produces
 * the bounded, redacted text for a single evolving "Working…" channel
 * message, the terse one-line receipt it collapses to at completion, and the
 * rate-limiting decision for whether a candidate edit is worth sending.
 *
 * Kept pure and adapter-agnostic so the composition/throttling rules are
 * unit-testable without a live channel or an instance manager. Lifecycle
 * (when to create/edit/collapse a draft, and serializing those calls per
 * task) lives in `progress-draft-manager.ts`.
 */

import { redactForEgress } from '../security/content-egress-gate';

/**
 * Minimum task duration before a draft is created at all. A short task (a
 * quick reply) never gets a "Working…" message — only the real answer, same
 * as today.
 */
export const DRAFT_CREATION_DELAY_MS = 8_000;

/** Minimum gap between successive edits to an already-created draft message. */
export const DRAFT_MIN_EDIT_INTERVAL_MS = 5_000;

/** Bounded length for the evolving draft body — well under any channel's hard message limit. */
export const DRAFT_MAX_LENGTH = 700;

const DRAFT_HEADER_PREFIX = 'Working on it';

export interface ProgressDraftStatus {
  /**
   * Latest status line, e.g. a tool summary ("Running Bash…"). Redacted via
   * the same egress gate used for other agent-authored channel output before
   * it is ever composed into the draft. Omit for a bare header.
   */
  detail?: string;
  /** Milliseconds elapsed since the task started. */
  elapsedMs: number;
}

export type ProgressDraftOutcome = 'success' | 'failure';

/** Format an elapsed duration as "12s" or "4m 12s" (matches the router's own completion-ping style). */
export function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Whether a task has run long enough to be worth narrating with a draft at
 * all — the "skip drafts for short tasks" rule.
 */
export function shouldCreateProgressDraft(
  elapsedMs: number,
  delayMs: number = DRAFT_CREATION_DELAY_MS,
): boolean {
  return elapsedMs >= delayMs;
}

/**
 * Compose the evolving draft body: a stable header plus, when present, one
 * redacted status line. Never carries raw commands/paths/secrets — reuses
 * the same egress redaction gate applied to other agent-authored channel
 * output (diff/prompt/webhook/memory egress).
 */
export function composeProgressDraftText(status: ProgressDraftStatus): string {
  const header = `${DRAFT_HEADER_PREFIX} — ${formatElapsedDuration(status.elapsedMs)}`;
  const redacted = normalizeProgressDraftDetail(status.detail);
  if (!redacted) return header;
  return truncate(`${header}\n${redacted}`, DRAFT_MAX_LENGTH);
}

/**
 * Redact and trim a raw status detail the same way `composeProgressDraftText`
 * does, without the time-varying header. Used as the change-detection key for
 * {@link shouldEmitProgressDraftUpdate}: the header's elapsed time changes on
 * every call by construction, so comparing the *rendered* text would defeat
 * "only edit on content change" — comparing the normalized detail instead
 * means an edit only fires when the actual status (not just the clock)
 * changed.
 */
export function normalizeProgressDraftDetail(detail?: string): string {
  if (!detail) return '';
  return redactForEgress(detail, { kind: 'channel' }).content.trim();
}

/**
 * Compose the one-line collapsed receipt the draft is replaced with at
 * completion/failure — deliberately terse (no tool/status detail) so the
 * calm final channel state never repeats potentially-sensitive in-flight
 * detail; the real answer (or error) follows as its own message.
 */
export function composeProgressDraftReceipt(elapsedMs: number, outcome: ProgressDraftOutcome): string {
  const duration = formatElapsedDuration(elapsedMs);
  return outcome === 'success'
    ? `Done in ${duration} — details follow`
    : `Hit a problem after ${duration} — details follow`;
}

/**
 * Rate-limiting/dedup decision for an already-created draft: only worth an
 * edit once the minimum interval has passed AND the composed text actually
 * changed — an unchanged tool/elapsed line would just churn edit calls for
 * nothing new to read. The very first edit (no `previous`) always proceeds;
 * the creation-delay gate (`shouldCreateProgressDraft`) already governs
 * whether a draft exists at all.
 */
export function shouldEmitProgressDraftUpdate(
  previous: { content: string; editedAt: number } | undefined,
  candidateContent: string,
  now: number,
  minIntervalMs: number = DRAFT_MIN_EDIT_INTERVAL_MS,
): boolean {
  if (!previous) return true;
  if (previous.content === candidateContent) return false;
  return now - previous.editedAt >= minIntervalMs;
}
