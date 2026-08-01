/**
 * Diff Annotation Anchor — pure, renderer-side re-anchoring for
 * `DiffAnnotation`s (WS-C4).
 *
 * This is a deliberately simple, renderer-local reuse of the main-process
 * anchor-verification IDEA (see `review-artifact-anchor.ts`), NOT an import
 * of it — renderer code must not reach into `src/main/...`. The algorithm
 * here is exact-match only:
 *
 *   - Search the CURRENT rendered lines for one side of a file's diff for
 *     an exact, contiguous, line-for-line match of the annotation's
 *     captured `excerpt`.
 *   - Exactly one match at the annotation's existing `lineRange` → `fresh`.
 *   - Exactly one match anywhere else → `re-anchored` to the new range.
 *   - Zero matches, or more than one (ambiguous) → `stale`. The last known
 *     `lineRange` and the original `excerpt` are left untouched so the
 *     comment is never silently lost or silently moved to the wrong place.
 */

import type {
  DiffAnnotation,
  DiffAnnotationLineRange,
} from '../../../../shared/types/diff-annotation.types';

/** One rendered line of a diff, on one side, for re-anchor search. */
export interface AnchorLine {
  /** 1-based line number on the side being searched. */
  lineNumber: number;
  /** Exact rendered text of the line (see caller for what "exact" means). */
  text: string;
}

/**
 * Re-anchor a single annotation against the CURRENT rendered lines for its
 * `side`. The caller is responsible for filtering `currentLines` down to
 * the correct file + side before calling this.
 */
export function reanchorAnnotation(
  annotation: DiffAnnotation,
  currentLines: AnchorLine[],
): DiffAnnotation {
  const excerptLines = annotation.excerpt.split('\n');
  const matches = findExcerptMatches(excerptLines, currentLines);

  if (matches.length !== 1) {
    // Zero or ambiguous matches — cannot safely place. Preserve the last
    // known position/text and flag stale.
    if (annotation.state === 'stale') return annotation;
    return { ...annotation, state: 'stale', updatedAt: Date.now() };
  }

  const match = matches[0];
  const unchanged =
    match.start === annotation.lineRange.start && match.end === annotation.lineRange.end;
  const nextState = unchanged ? 'fresh' : 're-anchored';

  if (unchanged && annotation.state === 'fresh') return annotation;

  return {
    ...annotation,
    lineRange: match,
    state: nextState,
    updatedAt: Date.now(),
  };
}

/** Every contiguous, exact, line-for-line match of `excerptLines` in `currentLines`. */
function findExcerptMatches(
  excerptLines: string[],
  currentLines: AnchorLine[],
): DiffAnnotationLineRange[] {
  const matches: DiffAnnotationLineRange[] = [];
  if (excerptLines.length === 0 || currentLines.length === 0) return matches;

  for (let i = 0; i + excerptLines.length <= currentLines.length; i++) {
    let isMatch = true;
    for (let j = 0; j < excerptLines.length; j++) {
      if (currentLines[i + j].text !== excerptLines[j]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      matches.push({
        start: currentLines[i].lineNumber,
        end: currentLines[i + excerptLines.length - 1].lineNumber,
      });
    }
  }
  return matches;
}

/**
 * Small deterministic (FNV-1a, 32-bit) content hash for `DiffAnnotation.workHash`.
 * Not cryptographic — informational only, cheap enough to compute per render.
 */
export function computeWorkHash(lines: AnchorLine[]): string {
  const joined = lines.map((l) => l.text).join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
