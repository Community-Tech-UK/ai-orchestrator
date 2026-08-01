/**
 * Diff Annotation Types (WS-C4)
 *
 * A `DiffAnnotation` is a review comment a user attaches to a specific
 * old/new-side line range in the diff viewer. Annotations are a renderer-
 * only concept: they live in a per-instance draft (see
 * `diff-review-draft.store.ts`) and are composed into a single plain-text
 * packet sent through the existing instance messaging path
 * (`InstanceStore.sendInput`). They are never persisted through IPC or
 * stored as their own main-process record.
 *
 * See docs/plans/2026-07-30-sibling-audit-round2_plan.md §WS-C4.
 */

/** Which side of the diff a line range refers to. */
export type DiffAnnotationSide = 'old' | 'new';

/** 1-based, inclusive line range on one side of a diff. */
export interface DiffAnnotationLineRange {
  start: number;
  end: number;
}

/**
 * Lifecycle of an annotation relative to the diff content it was created
 * against:
 * - `fresh`: created against (or successfully re-verified against) the
 *   diff currently on screen — the excerpt matches verbatim at `lineRange`.
 * - `re-anchored`: the diff changed, but the exact excerpt was found
 *   uniquely elsewhere on the same side and `lineRange` was moved to
 *   follow it.
 * - `stale`: the diff changed and the excerpt could not be uniquely
 *   re-located (zero or multiple matches). The last known `lineRange` and
 *   the original `excerpt` are preserved so the comment is not lost, but
 *   the UI must warn the user before it is sent.
 */
export type DiffAnnotationState = 'fresh' | 'stale' | 're-anchored';

export interface DiffAnnotation {
  id: string;
  /** Path relative to the repo root — matches git status/diff output. */
  path: string;
  side: DiffAnnotationSide;
  lineRange: DiffAnnotationLineRange;
  /**
   * Verbatim rendered text of the annotated lines (newline-joined),
   * captured at creation time. Used both to show the user what they
   * commented on and as the anchor for re-anchor/staleness detection.
   */
  excerpt: string;
  comment: string;
  /**
   * Optional short identifier for the diff content this annotation was
   * captured against (see `computeWorkHash` in `diff-annotation-anchor.ts`).
   * Informational only — re-anchoring relies on the exact-match search, not
   * on this hash.
   */
  workHash?: string;
  state: DiffAnnotationState;
  createdAt: number;
  updatedAt: number;
}

/** Fields the caller supplies when creating a new annotation. */
export type DiffAnnotationDraft = Pick<
  DiffAnnotation,
  'path' | 'side' | 'lineRange' | 'excerpt' | 'comment' | 'workHash'
>;
