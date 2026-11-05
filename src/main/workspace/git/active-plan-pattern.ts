/**
 * The one definition of an "active planning document", shared by Plan Queue
 * checkpoints, the landing guard, discovery and loop mode's auto-integration
 * guard (`active-plan-documents.ts`).
 *
 * It mirrors the shared plan-spec guard pre-commit hook
 * (`~/.config/git/hooks/plan-spec-guard.sh`), which refuses to commit these
 * files and exempts a document that declares itself a standing register near
 * its top. The hook and this module MUST change together:
 * `active-plan-pattern.spec.ts` pins this module against a fixture copy of the
 * hook's pattern and marker.
 *
 * Pure: no imports, no file access.
 */

/** `_spec|_spec_planned|_plan|_livetest|_history|-decisions-for-james` + `.md`, case-sensitive like the hook's `grep -E`. */
export const ACTIVE_PLAN_DOCUMENT_PATTERN = /(_spec|_spec_planned|_plan|_livetest|_history|-decisions-for-james)\.md$/;

/** The hook's exact marker text, matched anywhere on a line (`grep -F`). */
export const STANDING_REGISTER_MARKER = 'Type: standing register';

/** How many lines the hook (`head -8`) reads for the marker. */
export const MARKER_HEADER_LINES = 8;

/** A programme document that is not itself a queue job (each of its phases is queued separately). */
const NOT_AN_ITEM_RE = /^Queue:[ \t]*not an item[ \t]*$/im;

export function isActivePlanDocumentPath(filePath: string): boolean {
  return ACTIVE_PLAN_DOCUMENT_PATTERN.test(filePath);
}

function markerHeader(content: string): string {
  return content.split('\n').slice(0, MARKER_HEADER_LINES).join('\n');
}

/** True when one of the first 8 lines holds the hook's standing-register marker. */
export function declaresStandingRegister(content: string): boolean {
  return markerHeader(content).includes(STANDING_REGISTER_MARKER);
}

/** True when one of the first 8 lines is `Queue: not an item`. */
export function declaresNotAnItem(content: string): boolean {
  return NOT_AN_ITEM_RE.test(markerHeader(content));
}
