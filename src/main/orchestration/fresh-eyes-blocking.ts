/**
 * WS-A3 — which severity-blocking review findings may actually block.
 *
 * Extracted from `loop-coordinator-completion-gates.ts` so that file stays
 * inside its size ceiling; the logic is unchanged.
 */

import type { FreshEyesFinding } from './loop-fresh-eyes-reviewer';
import { verifyAnchor } from './review-artifact-anchor';

/**
 * WS-A3: split a review's severity-blocking candidates into those that may
 * actually block completion and those demoted to advisory because their
 * evidence could not be trusted.
 *
 * A finding blocks only if:
 *   (a) it is `evidenceClass: 'deterministic-gate'` — a hard-coded, non-LLM
 *       safety check (the secret-redaction sentinel), which is authoritative
 *       by construction and needs no anchor, OR
 *   (b) it carries an `anchor` whose quote {@link verifyAnchor}s as
 *       `verified` or `re-anchored` against `diffArtifactContent` — the
 *       durably persisted diff this exact review attempt was shown.
 *
 * Everything else (no anchor at all, or `evidence_unverified`) is demoted:
 * still visible, carries a `demotedReason`, but cannot block on severity
 * alone — a hallucinated, stale, or mislocated finding can no longer force
 * another loop cycle with nothing to prove the cited code exists.
 */
export function classifyFreshEyesBlocking(
  candidates: readonly FreshEyesFinding[],
  diffArtifactContent: string,
): { blocking: FreshEyesFinding[]; demoted: FreshEyesFinding[] } {
  const blocking: FreshEyesFinding[] = [];
  const demoted: FreshEyesFinding[] = [];

  for (const finding of candidates) {
    if (finding.evidenceClass === 'deterministic-gate') {
      blocking.push(finding);
      continue;
    }

    if (finding.anchor) {
      const result = verifyAnchor(diffArtifactContent, finding.anchor);
      if (result.status === 'verified') {
        blocking.push({ ...finding, anchorStatus: 'verified' });
        continue;
      }
      if (result.status === 're-anchored') {
        blocking.push({
          ...finding,
          anchorStatus: 're-anchored',
          anchor: {
            ...finding.anchor,
            ...(result.resolvedLineRange ? { lineRange: result.resolvedLineRange } : {}),
            ...(result.resolvedFile ? { file: result.resolvedFile } : {}),
          },
        });
        continue;
      }
      demoted.push({
        ...finding,
        anchorStatus: 'evidence_unverified',
        demotedReason:
          'The cited evidence quote could not be located in the reviewed diff — the finding may ' +
          'be stale, hallucinated, or mislocated. Demoted to advisory; it will not block completion ' +
          'on its own.',
      });
      continue;
    }

    demoted.push({
      ...finding,
      demotedReason:
        'No locatable evidence quote was supplied for this severity-blocking finding. Demoted to ' +
        'advisory; it will not block completion on its own.',
    });
  }

  return { blocking, demoted };
}
