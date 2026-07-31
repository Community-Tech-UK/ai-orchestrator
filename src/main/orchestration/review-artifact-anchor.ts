/**
 * Evidence-anchored review findings (WS-A3).
 *
 * A fresh-eyes review finding is only as trustworthy as the material it was
 * checked against. This module gives the completion gate two primitives:
 *
 * 1. `persistReviewArtifact` — durably record the exact diff / verify-output
 *    text a specific review attempt was shown, keyed by `reviewAttemptId` so
 *    a later check can prove "this is what the reviewer actually saw", not a
 *    freshly-recomputed (and possibly different) workspace diff.
 * 2. `verifyAnchor` — check a finding's cited quote against a persisted
 *    artifact: an exact (whitespace-normalized) match at the finding's
 *    stated location is `verified`; a match found in exactly one other place
 *    is `re-anchored` (the finding moved, but the evidence is real); zero or
 *    multiple matches is `evidence_unverified` — the finding cannot be
 *    trusted enough to block completion on its own.
 *
 * Persistence rides `LoopState.reviewArtifacts` (see `loop-state.types.ts`),
 * which is JSON-serialized wholesale as part of the existing loop checkpoint
 * (`loop-checkpoint.ts` → `loop-store-checkpoints.ts`). That store already
 * persists the *entire* `LoopState` blob on every checkpoint write, so a new
 * bounded field on `LoopState` needs no schema migration and survives
 * pause/resume exactly like `unresolvedReviewThreads` or
 * `recentEvidenceHashes` already do. The alternative — a dedicated SQL table
 * — would need a migration and a second write path for no benefit, since
 * nothing outside the loop's own completion gate ever queries an artifact by
 * anything other than `(reviewAttemptId, artifactType)`.
 */

import { createHash } from 'node:crypto';
import type { AnchorStatus, FindingAnchor } from '../../shared/types/review-evidence';
import type { LoopReviewArtifactEntry, LoopState } from '../../shared/types/loop.types';
import { EVIDENCE_TAIL_MARKER, MAX_REVIEW_PAYLOAD_CHARS } from './review-prompts';
import { extractJson } from './cross-model-review-service.helpers';

export { EVIDENCE_TAIL_MARKER };

/** Re-exported for callers that only need the size bound (tests, other modules). */
export { MAX_REVIEW_PAYLOAD_CHARS };

/**
 * Cap on how many `(reviewAttemptId, artifactType)` entries a run retains.
 * Each entry is bounded to `MAX_REVIEW_PAYLOAD_CHARS` (~32K) chars, so this
 * caps the worst-case addition to a checkpoint's JSON blob at roughly
 * `MAX_TRACKED_REVIEW_ARTIFACTS * MAX_REVIEW_PAYLOAD_CHARS` (~192KB for the
 * default of 6 entries — 3 review attempts' worth of diff+output pairs).
 * Older entries are evicted oldest-`createdAt`-first.
 */
export const MAX_TRACKED_REVIEW_ARTIFACTS = 6;

function artifactKey(reviewAttemptId: string, artifactType: LoopReviewArtifactEntry['artifactType']): string {
  return `${reviewAttemptId}:${artifactType}`;
}

/**
 * Evict the oldest entries beyond {@link MAX_TRACKED_REVIEW_ARTIFACTS}.
 *
 * Deliberately keyed on OBJECT INSERTION ORDER, not `createdAt`: several
 * artifacts can be persisted within the same wall-clock millisecond (e.g. the
 * gate's back-to-back diff + output calls, or a fast test), and `Date.now()`
 * ties would make a sort-by-timestamp eviction non-deterministic. String
 * object keys iterate in insertion order per the JS spec, so slicing the
 * trailing `MAX_TRACKED_REVIEW_ARTIFACTS` keys is exact and stable.
 */
function trimReviewArtifacts(
  entries: Record<string, LoopReviewArtifactEntry>,
): Record<string, LoopReviewArtifactEntry> {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_TRACKED_REVIEW_ARTIFACTS) return entries;
  const kept = keys.slice(keys.length - MAX_TRACKED_REVIEW_ARTIFACTS);
  const result: Record<string, LoopReviewArtifactEntry> = {};
  for (const key of kept) {
    result[key] = entries[key];
  }
  return result;
}

/**
 * Persist the exact material a review attempt was shown. The sha256 hash is
 * computed over the FULL, un-truncated content so it stays a stable identity
 * check even though the stored `content` itself is bounded — two calls with
 * identical input always produce the same `artifactHash`, regardless of
 * where the storage bound lands.
 */
export function persistReviewArtifact(input: {
  state: LoopState;
  iterationSeq: number;
  reviewAttemptId: string;
  artifactType: LoopReviewArtifactEntry['artifactType'];
  content: string;
}): { artifactHash: string } {
  const { state, iterationSeq, reviewAttemptId, artifactType, content } = input;
  const artifactHash = createHash('sha256').update(content).digest('hex');
  const stored = content.length > MAX_REVIEW_PAYLOAD_CHARS
    ? content.slice(0, MAX_REVIEW_PAYLOAD_CHARS)
    : content;
  const entries = { ...state.reviewArtifacts };
  entries[artifactKey(reviewAttemptId, artifactType)] = {
    reviewAttemptId,
    iterationSeq,
    artifactType,
    artifactHash,
    content: stored,
    createdAt: Date.now(),
  };
  state.reviewArtifacts = trimReviewArtifacts(entries);
  return { artifactHash };
}

export function getReviewArtifact(
  state: LoopState,
  reviewAttemptId: string,
  artifactType: LoopReviewArtifactEntry['artifactType'],
): LoopReviewArtifactEntry | undefined {
  return state.reviewArtifacts?.[artifactKey(reviewAttemptId, artifactType)];
}

/**
 * Collapse runs of horizontal whitespace (spaces/tabs) to a single space and
 * trim each line's leading/trailing horizontal whitespace, WITHOUT touching
 * line breaks. This lets a reviewer's re-typed quote match the artifact
 * despite differing indentation or inter-token spacing, while keeping line
 * numbers stable 1:1 with the original text (normalization never adds or
 * removes a `\n`, so `lineNumberAtOffset` on normalized text is exactly the
 * line number in the original artifact).
 */
export function normalizeForAnchorMatch(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n');
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    positions.push(idx);
    from = idx + Math.max(1, needle.length);
  }
  return positions;
}

/** 1-based line number containing character `offset` of `text`. */
function lineNumberAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/** A `+++ b/<file>` (tracked) or `+++ new file: <file>` (untracked block) diff marker. */
const FILE_MARKER_RE = /^\+\+\+ (?:b\/(.+)|new file: (.+))$/;

interface FileSegment {
  file: string;
  /** 1-based, inclusive line-number range of this file's content within the artifact. */
  startLine: number;
  endLine: number;
}

/**
 * Split a diff-shaped artifact into per-file line ranges using its `+++`
 * markers. Returns an empty array for non-diff artifacts (e.g. a verify
 * `output` artifact) — callers fall back to file-less matching in that case.
 */
function findFileSegments(artifact: string): FileSegment[] {
  const lines = artifact.split('\n');
  const markers: { file: string; lineNo: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = FILE_MARKER_RE.exec(lines[i]);
    if (match) markers.push({ file: (match[1] ?? match[2] ?? '').trim(), lineNo: i + 1 });
  }
  return markers.map((marker, index) => ({
    file: marker.file,
    startLine: marker.lineNo + 1,
    endLine: index + 1 < markers.length ? markers[index + 1].lineNo - 1 : lines.length,
  }));
}

/** Loose file-path match: exact, or one path is a `/`-suffix of the other (handles `a/`/`b/` diff prefixes). */
function filesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export interface AnchorVerificationResult {
  status: AnchorStatus;
  /** Set only when `status === 're-anchored'`: where the sole match actually is. */
  resolvedLineRange?: [number, number];
  resolvedFile?: string;
}

/**
 * Verify a finding's cited {@link FindingAnchor} against a persisted artifact.
 *
 * - Zero or more-than-one (whitespace-normalized) occurrences of `quote`
 *   anywhere in the artifact → `evidence_unverified` (missing or ambiguous —
 *   we cannot tell which occurrence the finding meant).
 * - Exactly one occurrence, and it sits at the finding's stated location
 *   (its file's diff segment, when both are determinable; otherwise its
 *   stated line range; otherwise unconditionally, when no location was
 *   stated) → `verified`.
 * - Exactly one occurrence, but NOT at the stated location → `re-anchored`:
 *   the evidence is real, just stale metadata. `resolvedLineRange` (and
 *   `resolvedFile`, when a diff file segment could be determined) report
 *   where it actually is, for the caller to update the finding's anchor.
 */
export function verifyAnchor(artifact: string, anchor: FindingAnchor): AnchorVerificationResult {
  const normalizedArtifact = normalizeForAnchorMatch(artifact);
  const normalizedQuote = normalizeForAnchorMatch(anchor.quote).trim();
  if (!normalizedQuote) return { status: 'evidence_unverified' };

  const offsets = findAllOccurrences(normalizedArtifact, normalizedQuote);
  if (offsets.length !== 1) return { status: 'evidence_unverified' };

  const startLine = lineNumberAtOffset(normalizedArtifact, offsets[0]);
  const newlineCount = (normalizedQuote.match(/\n/g) ?? []).length;
  const foundRange: [number, number] = [startLine, startLine + newlineCount];

  const segments = findFileSegments(normalizedArtifact);
  const foundSegment = segments.find((s) => startLine >= s.startLine && startLine <= s.endLine);
  const hasFileStructure = segments.length > 0;

  const atStatedLocation = ((): boolean => {
    if (anchor.file && hasFileStructure) {
      // The artifact IS diff-shaped, so a stated file is checkable. A file
      // that doesn't appear in this diff AT ALL is not "unknown" — it's a
      // clear miss, not a trivial pass, even though the quote exists
      // somewhere else in the same artifact.
      const statedSegment = segments.find((s) => filesMatch(s.file, anchor.file!));
      if (!statedSegment) return false;
      return startLine >= statedSegment.startLine && startLine <= statedSegment.endLine;
    }
    // Either no file was stated, or the artifact carries no per-file
    // structure at all (e.g. a plain verify `output` artifact) — fall back
    // to the stated line range, if any.
    if (anchor.lineRange) {
      const [lo, hi] = anchor.lineRange;
      return foundRange[0] <= hi && foundRange[1] >= lo;
    }
    // No location was stated at all — the sole match trivially counts.
    return true;
  })();

  if (atStatedLocation) return { status: 'verified' };

  return {
    status: 're-anchored',
    resolvedLineRange: foundRange,
    ...(foundSegment ? { resolvedFile: foundSegment.file } : {}),
  };
}

/**
 * Split a reviewer-authored issue string into its plain-text description and
 * an optional {@link FindingAnchor} parsed from a trailing `#EVIDENCE#` tail.
 *
 * Fail-safe by construction: a missing marker, a marker not on its own line,
 * unparseable JSON, or a missing/empty `quote` all fall back to "no anchor"
 * — the issue text is preserved verbatim and the caller treats the finding
 * as unlocalized-advisory. A parse failure here can only ever make evidence
 * classification MORE conservative (fewer findings gain blocking power),
 * matching the house-style rule that a parse failure is never treated as a
 * pass.
 */
export function parseEvidenceTail(issueText: string): { text: string; anchor?: FindingAnchor } {
  const markerIdx = issueText.indexOf(EVIDENCE_TAIL_MARKER);
  const fallback = { text: issueText.trim() };
  if (markerIdx === -1) return fallback;
  const precedingChar = markerIdx === 0 ? '\n' : issueText[markerIdx - 1];
  if (precedingChar !== '\n') return fallback;

  const head = issueText.slice(0, markerIdx).trim();
  const tail = issueText.slice(markerIdx + EVIDENCE_TAIL_MARKER.length).replace(/^\r?\n/, '');
  const text = head || issueText.trim();

  const parsed = extractJson(tail);
  if (typeof parsed !== 'object' || parsed === null) return { text };
  const obj = parsed as Record<string, unknown>;
  const quote = typeof obj['quote'] === 'string' ? obj['quote'].trim() : '';
  if (!quote) return { text };

  const file = typeof obj['file'] === 'string' && obj['file'].trim() ? obj['file'].trim() : undefined;
  let lineRange: [number, number] | undefined;
  const lines = obj['lines'];
  if (
    Array.isArray(lines) &&
    lines.length === 2 &&
    lines.every((n): n is number => typeof n === 'number' && Number.isFinite(n))
  ) {
    const [a, b] = lines as [number, number];
    lineRange = a <= b ? [a, b] : [b, a];
  }

  return {
    text,
    anchor: { quote, ...(file ? { file } : {}), ...(lineRange ? { lineRange } : {}) },
  };
}
