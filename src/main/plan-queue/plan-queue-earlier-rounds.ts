/**
 * The checker's "Earlier rounds" block (Phase C, Step 4).
 *
 * Rounds 2 and later tell the checker what failed before, what the worker said
 * it did about each finding (always "unconfirmed, re-check"), and which files
 * changed since the last check. The whole block fits MAX_DATA_CHARS. A cut at
 * the limit would remove the newest findings, which matter most, so the block
 * is built to fit: long fields are shortened first, then the oldest rounds go
 * and a count says how many, then the latest round's own later findings.
 */

import { escapeForDataBlock, MAX_DATA_CHARS } from './plan-queue-prompts';

export const EARLIER_ROUNDS_TAG = 'earlier_rounds';
const SUMMARY_LIMIT = 400;
const CLAIM_LIMIT = 800;
const DIFF_LIMIT = 2_000;
const UNCONFIRMED = 'unconfirmed, re-check';

export interface EarlierRoundInput {
  round: number;
  findings: readonly { severity?: string; summary: string; file?: string }[];
  /** What the worker said about this round's findings; null when nothing was recorded. */
  workerClaim: string | null;
}

interface RoundView {
  round: number;
  status: string;
  workerClaim: string;
  findings: { severity?: string; file?: string; summary: string }[];
  findingsOmitted?: number;
}

function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function buildEarlierRoundsBlock(rounds: readonly EarlierRoundInput[], diffSinceLastCheck: string, limit = MAX_DATA_CHARS): string {
  const views: RoundView[] = rounds.map(round => ({
    round: round.round,
    status: UNCONFIRMED,
    workerClaim: shorten(round.workerClaim ?? 'No claimed fix was recorded.', CLAIM_LIMIT),
    findings: round.findings.map(finding => ({
      ...(finding.severity ? { severity: finding.severity } : {}),
      ...(finding.file ? { file: shorten(finding.file, 200) } : {}),
      summary: shorten(finding.summary, SUMMARY_LIMIT),
    })),
  }));
  let omittedRounds = 0;
  const render = () => JSON.stringify({
    ...(omittedRounds ? { olderRoundsOmitted: omittedRounds } : {}),
    earlier: views,
    diffSinceLastCheck: shorten(diffSinceLastCheck, DIFF_LIMIT),
  });
  const fits = () => escapeForDataBlock(EARLIER_ROUNDS_TAG, render()).length <= limit;
  while (!fits() && views.length > 1) { views.shift(); omittedRounds++; }
  // One round left and still too long: keep its first findings, say how many were left out.
  const last = views[0];
  while (!fits() && last && last.findings.length > 1) {
    last.findings.pop();
    last.findingsOmitted = (last.findingsOmitted ?? 0) + 1;
  }
  return render();
}
