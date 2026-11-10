/**
 * What Harness says when files Git ignores in the main folder stop a merge. The main process writes these
 * reasons (src/main/workspace/git/ignored-file-guard.ts); screens that show only reasons they recognise use
 * {@link isIgnoredFilesReason}, so the two cannot drift apart.
 */

/** How many places a reason names before it counts the rest. */
const NAMED_PLACES = 5;

// These say what happened and what to move, but not how to retry: each screen adds that, because they differ.
export const IGNORED_FILES_UNCHECKED_REASON = 'Harness could not check the main folder for files Git ignores, so nothing was merged.'
  + ' The Harness log says why.';

/**
 * A reason {@link ignoredFilesReason} wrote. Places come from Git, relative to the repository; one that starts
 * with `/` does not count, so a screen never shows someone's folder layout.
 */
const IGNORED_FILES_PATTERN = new RegExp(
  '^The main folder has (?:a file Git ignores at|files Git ignores (?:at|in)) (?![/\\s])(?!.*(?:, | and )/)[^\\n]{1,2000}'
  + ', which Git would replace without asking if this goes ahead\\. Move (?:it|them) out of the way'
  + '(?:; the Harness log lists them all)?\\.$',
);

/**
 * Why a merge cannot go ahead, naming the places in the way; a folder's name ends with `/`. Past the first few
 * it counts the rest, which the caller must log (ignoredFilesBlockReason does).
 */
export function ignoredFilesReason(places: readonly string[]): string {
  const named = places.slice(0, NAMED_PLACES);
  const rest = places.length - named.length;
  const list = rest > 0
    ? `${named.join(', ')} and ${rest} more`
    : named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}` : named[0];
  const oneFile = places.length === 1 && !places[0].endsWith('/');
  const what = oneFile ? 'a file Git ignores at' : places.length === 1 ? 'files Git ignores in' : 'files Git ignores at';
  return `The main folder has ${what} ${list}, which Git would replace without asking if this goes ahead. `
    + `Move ${oneFile ? 'it' : 'them'} out of the way${rest > 0 ? '; the Harness log lists them all' : ''}.`;
}

/** Whether `reason` is one of the reasons above. */
export function isIgnoredFilesReason(reason: string): boolean {
  return reason === IGNORED_FILES_UNCHECKED_REASON || IGNORED_FILES_PATTERN.test(reason);
}
