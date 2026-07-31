import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_TAIL_MARKER,
  getReviewArtifact,
  MAX_REVIEW_PAYLOAD_CHARS,
  MAX_TRACKED_REVIEW_ARTIFACTS,
  normalizeForAnchorMatch,
  parseEvidenceTail,
  persistReviewArtifact,
  verifyAnchor,
} from './review-artifact-anchor';
import type { LoopState } from '../../shared/types/loop.types';

/** persistReviewArtifact/getReviewArtifact only touch `reviewArtifacts` — a
 *  bare fixture keeps these tests focused without dragging in a full LoopState. */
function makeState(): LoopState {
  return { reviewArtifacts: undefined } as unknown as LoopState;
}

const SAMPLE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@ function foo() {',
  ' context line',
  '-const data = await res.json();',
  '+const data = await res.json();',
  '+console.log("added");',
  '',
  'diff --git a/src/b.ts b/src/b.ts',
  'index 333..444 100644',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,2 +1,3 @@',
  ' const x = 1;',
  '+const y = 2;',
].join('\n');

describe('verifyAnchor', () => {
  it('verifies an exact quote found at the stated file location', () => {
    const result = verifyAnchor(SAMPLE_DIFF, {
      file: 'src/a.ts',
      quote: 'console.log("added");',
    });
    expect(result).toEqual({ status: 'verified' });
  });

  it('verifies when no location was stated at all and the quote is unique', () => {
    const result = verifyAnchor(SAMPLE_DIFF, { quote: 'const y = 2;' });
    expect(result.status).toBe('verified');
  });

  it('re-anchors a unique quote found somewhere other than the stated file', () => {
    // The quote genuinely exists (in src/b.ts), but the finding claims a.ts.
    const result = verifyAnchor(SAMPLE_DIFF, {
      file: 'src/a.ts',
      quote: 'const y = 2;',
    });
    expect(result.status).toBe('re-anchored');
    expect(result.resolvedFile).toBe('src/b.ts');
    expect(result.resolvedLineRange).toBeDefined();
  });

  it('marks an evidence_unverified result when the quote appears more than once (ambiguous)', () => {
    const artifact = 'foo bar\nfoo bar\n';
    const result = verifyAnchor(artifact, { quote: 'foo bar' });
    expect(result).toEqual({ status: 'evidence_unverified' });
  });

  it('marks an evidence_unverified result when the quote is missing entirely', () => {
    const result = verifyAnchor(SAMPLE_DIFF, { quote: 'this text does not exist anywhere' });
    expect(result).toEqual({ status: 'evidence_unverified' });
  });

  it('matches despite whitespace differences (re-typed indentation/spacing)', () => {
    const artifact = 'function foo() {\n    const   data =   await res.json();\n}\n';
    const result = verifyAnchor(artifact, { quote: 'const data = await res.json();' });
    expect(result.status).toBe('verified');
  });

  it('treats an empty or whitespace-only quote as unverified', () => {
    expect(verifyAnchor(SAMPLE_DIFF, { quote: '   ' })).toEqual({ status: 'evidence_unverified' });
  });
});

describe('normalizeForAnchorMatch', () => {
  it('collapses runs of horizontal whitespace but preserves line breaks', () => {
    expect(normalizeForAnchorMatch('a  \t b\n\n  c   d  ')).toBe('a b\n\nc d');
  });
});

describe('persistReviewArtifact', () => {
  it('produces a stable hash for identical content across separate calls', () => {
    const stateA = makeState();
    const stateB = makeState();
    const content = 'diff --git a/x.ts b/x.ts\n+added line\n';
    const { artifactHash: hashA } = persistReviewArtifact({
      state: stateA, iterationSeq: 1, reviewAttemptId: 'attempt-1', artifactType: 'diff', content,
    });
    const { artifactHash: hashB } = persistReviewArtifact({
      state: stateB, iterationSeq: 5, reviewAttemptId: 'attempt-2', artifactType: 'diff', content,
    });
    expect(hashA).toBe(hashB);
  });

  it('bounds stored content to MAX_REVIEW_PAYLOAD_CHARS while hashing the full content', () => {
    const state = makeState();
    const content = 'x'.repeat(MAX_REVIEW_PAYLOAD_CHARS + 500);
    const { artifactHash } = persistReviewArtifact({
      state, iterationSeq: 0, reviewAttemptId: 'attempt-1', artifactType: 'diff', content,
    });
    const stored = getReviewArtifact(state, 'attempt-1', 'diff');
    expect(stored?.content.length).toBe(MAX_REVIEW_PAYLOAD_CHARS);
    // Hash was computed over the FULL content, not the truncated copy.
    const shortHash = persistReviewArtifact({
      state: makeState(), iterationSeq: 0, reviewAttemptId: 'x', artifactType: 'diff',
      content: content.slice(0, MAX_REVIEW_PAYLOAD_CHARS),
    }).artifactHash;
    expect(artifactHash).not.toBe(shortHash);
  });

  it('retrieves the diff and output artifacts independently for the same attempt', () => {
    const state = makeState();
    persistReviewArtifact({ state, iterationSeq: 2, reviewAttemptId: 'a1', artifactType: 'diff', content: 'the diff' });
    persistReviewArtifact({ state, iterationSeq: 2, reviewAttemptId: 'a1', artifactType: 'output', content: 'the output' });
    expect(getReviewArtifact(state, 'a1', 'diff')?.content).toBe('the diff');
    expect(getReviewArtifact(state, 'a1', 'output')?.content).toBe('the output');
    expect(getReviewArtifact(state, 'a1', 'diff')?.iterationSeq).toBe(2);
  });

  it('evicts the oldest entries once MAX_TRACKED_REVIEW_ARTIFACTS is exceeded', () => {
    const state = makeState();
    for (let i = 0; i < MAX_TRACKED_REVIEW_ARTIFACTS + 2; i++) {
      persistReviewArtifact({
        state, iterationSeq: i, reviewAttemptId: `attempt-${i}`, artifactType: 'diff', content: `content ${i}`,
      });
    }
    expect(Object.keys(state.reviewArtifacts ?? {}).length).toBe(MAX_TRACKED_REVIEW_ARTIFACTS);
    // The oldest attempts (0, 1) were evicted; the newest survive.
    expect(getReviewArtifact(state, 'attempt-0', 'diff')).toBeUndefined();
    expect(getReviewArtifact(state, 'attempt-1', 'diff')).toBeUndefined();
    expect(getReviewArtifact(state, `attempt-${MAX_TRACKED_REVIEW_ARTIFACTS + 1}`, 'diff')?.content)
      .toBe(`content ${MAX_TRACKED_REVIEW_ARTIFACTS + 1}`);
  });
});

describe('parseEvidenceTail', () => {
  it('parses a well-formed tail into text + anchor', () => {
    const issue = `The handler never checks the response status.\n${EVIDENCE_TAIL_MARKER}\n` +
      `{"file": "src/api/client.ts", "lines": [42, 44], "quote": "const data = await res.json();"}`;
    const { text, anchor } = parseEvidenceTail(issue);
    expect(text).toBe('The handler never checks the response status.');
    expect(anchor).toEqual({
      quote: 'const data = await res.json();',
      file: 'src/api/client.ts',
      lineRange: [42, 44],
    });
  });

  it('returns no anchor when there is no marker at all', () => {
    expect(parseEvidenceTail('Just a plain observation.')).toEqual({ text: 'Just a plain observation.' });
  });

  it('returns no anchor when the marker is not on its own line', () => {
    const issue = `Some text ${EVIDENCE_TAIL_MARKER} {"quote": "x"}`;
    expect(parseEvidenceTail(issue)).toEqual({ text: issue.trim() });
  });

  it('falls back to the head text when the tail JSON is malformed', () => {
    const issue = `Broken evidence.\n${EVIDENCE_TAIL_MARKER}\nnot valid json at all {{{`;
    expect(parseEvidenceTail(issue)).toEqual({ text: 'Broken evidence.' });
  });

  it('drops a tail whose quote is missing or empty', () => {
    const issue = `No quote supplied.\n${EVIDENCE_TAIL_MARKER}\n{"file": "src/a.ts"}`;
    expect(parseEvidenceTail(issue)).toEqual({ text: 'No quote supplied.' });
  });

  it('works with no preceding head text (marker at the very start)', () => {
    const issue = `${EVIDENCE_TAIL_MARKER}\n{"quote": "const y = 2;"}`;
    expect(parseEvidenceTail(issue)).toEqual({
      text: issue.trim(),
      anchor: { quote: 'const y = 2;' },
    });
  });
});
