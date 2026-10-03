/**
 * Detect an ACP turn that ended on a provider content-filter rejection.
 *
 * Observed on OpenCode session ses_f042d0c3fffeyvPKD2HFx9pSZl (Harness instance
 * iuxohtji2, MiMo v2.6 Pro). The last step finished `content-filter` with a
 * one-token text part, "The request was rejected because it was considered
 * high risk", glued onto the status narration. OpenCode then exited its agent
 * loop and ACP reported `end_turn`, so the session went idle.
 */

const CONTENT_FILTER_SENTENCE = 'The request was rejected because it was considered high risk';

/** True when the assistant text ends on the provider's content-filter sentence. */
export function isContentFilterEnding(text: string): boolean {
  const trimmed = text.trim().replace(/[.]+$/, '');
  if (!trimmed.endsWith(CONTENT_FILTER_SENTENCE)) return false;
  if (trimmed.length === CONTENT_FILTER_SENTENCE.length) return true;
  const before = trimmed[trimmed.length - CONTENT_FILTER_SENTENCE.length - 1];
  return before === '\n' || before === '.' || before === '!' || before === '?' || before === ' ';
}
