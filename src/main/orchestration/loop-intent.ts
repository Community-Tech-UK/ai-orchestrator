/**
 * Loop intent detection.
 *
 * Some loop goals carry an explicit "converge until clean" intent — the
 * canonical example is "keep doing a review with fresh eyes and fix any
 * issues, until there are no issues." For that intent the loop should not
 * stop on the agent's own say-so: it must run an independent fresh-eyes
 * cross-model review before accepting completion. The coordinator uses this
 * detector to auto-enable `completion.crossModelReview` when the caller did
 * not explicitly configure it (an explicit `{ enabled: false }` still wins).
 *
 * The detector is intentionally conservative — it favours false negatives
 * (no auto-enable) over false positives (surprising the user with extra
 * cross-CLI calls). A strong, unambiguous "fresh eyes" mention is sufficient
 * on its own; otherwise we require BOTH a review/audit verb AND a
 * convergence cue ("until no issues", "until clean", "keep reviewing",
 * "repeatedly", …).
 */

/** "fresh eyes" / "fresh-eyes" anywhere is a strong, unambiguous signal. */
const FRESH_EYES_RE = /\bfresh[\s-]?eyes\b/i;

/** Verbs that indicate the user wants an evaluative pass, not just edits. */
const REVIEW_VERB_RE = /\b(re-?review|review|reviewing|critique|critiquing|audit|auditing|vet|vetting|inspect|inspecting)\b/i;

/**
 * Cues that the user wants the work repeated until a clean state — i.e. the
 * loop should converge on "no issues" rather than stop after one pass.
 */
const CONVERGENCE_CUE_RES: RegExp[] = [
  /\buntil\s+(?:there\s+are\s+)?(?:no|zero|0)\s+(?:more\s+)?(?:issues?|problems?|bugs?|errors?|findings?|defects?|concerns?)\b/i,
  /\buntil\s+(?:it'?s\s+|they'?re\s+|everything\s+is\s+|the\s+code\s+is\s+)?clean\b/i,
  /\buntil\s+(?:there\s+are\s+)?none(?:\s+left)?\b/i,
  /\buntil\s+(?:it\s+)?(?:passes|converges|is\s+done|is\s+complete)\b/i,
  /\b(?:keep|continue)\s+(?:reviewing|review|critiquing|auditing|iterating|going|fixing)\b/i,
  /\brepeatedly\b/i,
  /\bover\s+and\s+over\b/i,
  /\b(?:fix|resolve|address)\s+(?:any|all|every|the)\s+(?:issues?|problems?|bugs?|errors?|findings?)\b.*\buntil\b/i,
];

export interface ConvergeUntilCleanDetection {
  matched: boolean;
  /** Short machine-readable reason, useful for logs/telemetry. */
  reason: 'fresh-eyes-phrase' | 'review-verb+convergence-cue' | 'none';
}

/**
 * Inspect the loop's goal (and optional continuation directive) for the
 * "converge until clean" intent. Returns a structured result so callers can
 * log *why* the intent was (or wasn't) detected.
 */
export function detectConvergeUntilCleanIntent(
  initialPrompt: string,
  iterationPrompt?: string,
): ConvergeUntilCleanDetection {
  const text = `${initialPrompt ?? ''}\n${iterationPrompt ?? ''}`;

  if (FRESH_EYES_RE.test(text)) {
    return { matched: true, reason: 'fresh-eyes-phrase' };
  }

  const hasReviewVerb = REVIEW_VERB_RE.test(text);
  const hasConvergenceCue = CONVERGENCE_CUE_RES.some((re) => re.test(text));
  if (hasReviewVerb && hasConvergenceCue) {
    return { matched: true, reason: 'review-verb+convergence-cue' };
  }

  return { matched: false, reason: 'none' };
}

/** Convenience boolean wrapper around {@link detectConvergeUntilCleanIntent}. */
export function looksLikeConvergeUntilCleanIntent(
  initialPrompt: string,
  iterationPrompt?: string,
): boolean {
  return detectConvergeUntilCleanIntent(initialPrompt, iterationPrompt).matched;
}
