/**
 * Manual compaction preview types (WS-B7).
 *
 * Shared between main (builds the preview + honors the boundary when
 * applying) and renderer (types the preview dialog). See
 * `src/main/context/compaction-preview.ts` for the read-only preview
 * builder and `src/main/context/compaction-boundary.ts` for the pure
 * boundary math both the preview and the real compaction cut share.
 */

/**
 * How compaction would actually run for this instance right now:
 * - `aio-managed`: AIO's own restart-with-summary path — the boundary
 *   control applies and the affected range is real.
 * - `adapter-self-managed`: the provider CLI compacts its own context
 *   internally (e.g. Codex app-server). AIO cannot preview or bound it;
 *   confirming defers to the provider's own behavior.
 * - `unavailable`: no preview could be produced (e.g. the instance no
 *   longer exists).
 */
export type CompactionPreviewMode = 'aio-managed' | 'adapter-self-managed' | 'unavailable';

/**
 * Inclusive index range (into the user/assistant transcript) that would be
 * summarized. `messageCount` is the authoritative affected count — the
 * always-protect-most-recent-user-turn rule can rescue a single turn from
 * the middle of this span (its own opening user turn), so `[fromIndex,
 * toIndex]` bounds the span but is not guaranteed fully contiguous.
 */
export interface CompactionAffectedRange {
  fromIndex: number;
  toIndex: number;
  messageCount: number;
}

export interface CompactionTokenEstimate {
  value: number;
  /**
   * `measured` — a real provider-reported token count (only meaningful for
   * `adapter-self-managed`, where AIO cites the provider's own contextUsage).
   * `heuristic` — AIO's character-based token estimate over the affected
   * range, the same estimator the real compaction path uses.
   */
  source: 'measured' | 'heuristic';
}

export interface CompactionProtectedItems {
  /** Whether the always-protect-most-recent-user-turn rule rescued a turn from the affected range for this boundary. */
  mostRecentUserTurnProtected: boolean;
  /** Whether authenticated ledger evidence would be folded into the compaction summary rather than lost. */
  authenticatedEvidencePreserved: boolean;
}

export interface CompactionPreview {
  mode: CompactionPreviewMode;
  affectedRange: CompactionAffectedRange;
  /** Number of transcript turns (messages) that would remain verbatim. */
  keptVerbatimCount: number;
  tokenEstimate: CompactionTokenEstimate;
  protectedItems: CompactionProtectedItems;
  /** Total user/assistant turns currently in the transcript. */
  totalMessageCount: number;
  /** Total exchanges (a user turn + its following assistant turns) currently in the transcript. */
  totalExchangeCount: number;
  /** The keep-latest-N-exchanges value this preview was computed with (echoed back; a default is filled in when the caller omits it). */
  keepLatestExchanges: number;
  /** Human-readable caveat for non-`aio-managed` modes; null when the structured fields say everything necessary. */
  note: string | null;
}

/** Boundary option accepted by both the preview and the real manual-compaction apply path. */
export interface CompactionBoundaryOptions {
  /** Keep the latest N exchanges verbatim; omit for the pre-WS-B7 default behavior. */
  keepLatestExchanges?: number;
}
