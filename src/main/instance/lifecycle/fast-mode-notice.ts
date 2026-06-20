/**
 * Detect a provider "fast mode unavailable" notice in output text.
 *
 * Fast mode is gated behind a paid subscription / usage credits (Claude) and a
 * priority-tier-eligible plan (Codex). When the CLI can't honor the requested
 * fast mode it emits a human-readable notice on the output stream rather than
 * failing the turn. We watch for it so the lifecycle can auto-revert the toggle
 * (keeping UI state truthful) while the notice itself surfaces in the transcript.
 *
 * Matched Claude notices include:
 *   - "Fast mode requires a paid subscription"
 *   - "Fast mode requires usage credits"
 *   - "Fast mode unavailable: …"
 *   - "Fast mode is currently unavailable"
 *   - "Fast mode is not available"
 *   - "Fast mode has been disabled by your organization"
 *
 * Kept deliberately narrow (must mention "fast mode" AND an unavailability
 * phrase) so ordinary prose mentioning fast mode does not trip a false revert.
 */
const FAST_MODE_UNAVAILABLE_PATTERN =
  /fast mode\b[^\n]*?\b(?:unavailable|not available|requires|disabled|currently unavailable)/i;

export function isFastModeUnavailableNotice(text: string | undefined | null): boolean {
  if (!text) return false;
  return FAST_MODE_UNAVAILABLE_PATTERN.test(text);
}
