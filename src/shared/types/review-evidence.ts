/**
 * Evidence-anchoring types for review findings (WS-A3).
 *
 * A review finding (fresh-eyes cross-model review or headless CLI review) can
 * carry an optional `anchor` — an exact quote copied from the material the
 * reviewer actually saw, plus best-effort file/line hints. `review-artifact-
 * anchor.ts` verifies the quote against the durably persisted artifact for a
 * specific review attempt; the resulting {@link AnchorStatus} tells the
 * completion gate whether the finding's evidence is trustworthy enough to
 * block completion.
 *
 * Kept here (not in `orchestration/`) because both `HeadlessReviewFinding`
 * (cli-entrypoints) and `FreshEyesFinding` (orchestration) need the shape and
 * neither module should import from the other.
 */

/** Outcome of checking a finding's {@link FindingAnchor} against a persisted artifact. */
export type AnchorStatus = 'verified' | 're-anchored' | 'evidence_unverified';

/**
 * How much weight a finding's evidence carries in the completion gate:
 * - `localized`: the finding cites a quote (an `anchor`) that can be checked
 *   against the reviewed artifact.
 * - `unlocalized-advisory`: no locatable quote was supplied — the finding is
 *   always advisory, regardless of severity.
 * - `deterministic-gate`: not a model judgement at all but a hard-coded,
 *   non-LLM safety check (e.g. the secret-redaction sentinel). Always blocks
 *   when severity-eligible; anchor verification does not apply.
 */
export type EvidenceClass = 'localized' | 'unlocalized-advisory' | 'deterministic-gate';

/**
 * A finding's cited evidence. `quote` must be copied verbatim (exact
 * substring, modulo whitespace normalization — see
 * `review-artifact-anchor.ts`) from the material under review; `file` and
 * `lineRange` are best-effort location hints used to tell "verified in place"
 * apart from "moved" (re-anchored).
 */
export interface FindingAnchor {
  file?: string;
  /** 1-based, inclusive [start, end] line range within the cited file. */
  lineRange?: [number, number];
  quote: string;
}
