/**
 * Plan Queue progress fingerprints and stable finding identities.
 *
 * One definition, used by the restart counter (Step 3), the no-progress check
 * (Step 4) and the plan diet (Step 5): a round's work is "the same" when its
 * worktree HEAD and its root document hash are both unchanged. A finding keeps
 * one id across rounds so a defect the checker reports twice can be recognised.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PlanQueueFinding } from '@contracts/schemas/plan-queue';
import type { PlanQueueItem } from './plan-queue.types';
import type { PlanQueueHistoryStore } from './plan-queue-history-store';

export interface PlanQueueProgressFingerprint {
  /** HEAD of the item's worktree at the last round (its checkpoint commit). */
  worktreeHead: string | null;
  /** SHA-256 of the root document's bytes at the last round. */
  documentSha256: string | null;
  round: number;
}

export function progressFingerprint(
  worktreeHead: string | null,
  documentSha256: string | null,
  round: number,
): PlanQueueProgressFingerprint {
  return { worktreeHead, documentSha256, round };
}

/**
 * True when both the HEAD and the document hash are the same. Null on either
 * side means "we do not know", which is never "unchanged".
 */
export function progressUnchanged(
  before: PlanQueueProgressFingerprint | null,
  after: PlanQueueProgressFingerprint | null,
): boolean {
  return Boolean(
    before && after
    && before.worktreeHead && after.worktreeHead && before.worktreeHead === after.worktreeHead
    && before.documentSha256 && after.documentSha256 && before.documentSha256 === after.documentSha256,
  );
}

/** SHA-256 of the root document's bytes; null when it cannot be read. */
export async function documentContentSha256(documentPath: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(documentPath)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Stable finding identity: SHA-256 of the normalised summary ("title") and
 * file, so the same defect reported in two rounds matches and a reworded
 * summary does not.
 */
export function planQueueFindingId(finding: Pick<PlanQueueFinding, 'summary' | 'file'>): string {
  const normalized = `${normalizeFindingPart(finding.summary)}|${normalizeFindingPart(finding.file ?? '').replace(/:\d+(?::\d+)?$/, '')}`;
  return createHash('sha256').update(normalized).digest('hex');
}

function normalizeFindingPart(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Between-round memory (Step 4)
// ---------------------------------------------------------------------------

export const NOTHING_CHANGED_PROMPT = 'Nothing changed since the last check failed. Fix each finding or explain with file:line evidence why it is wrong.';

/**
 * The same finding surviving three rounds would park as
 * `stuck-on-same-finding`. Shipped log-only for a one-week live observation
 * first; flip this after that week, never before.
 */
export const PARK_ON_REPEATED_FINDING = false;

export type NoProgressDecision =
  | { kind: 'continue' }
  | { kind: 'reprompt'; prompt: string }
  | { kind: 'park'; detail: string };

/** The rows `decideNoProgress` and `repeatedFindingIds` read (Step 1's verdicts). */
export interface ProgressVerdictRow {
  round: number;
  verdict: string;
  findings: readonly { id: string; severity?: string; summary: string; file?: string }[];
  worktreeHead: string | null;
  documentSha256: string | null;
}

/**
 * If HEAD and the document hash are both unchanged since the last FAIL, the
 * checker would re-read the same work: re-prompt the worker once, and park as
 * `no-progress` while it is still unchanged.
 */
export async function decideNoProgress(
  rows: readonly ProgressVerdictRow[],
  item: PlanQueueItem,
  previouslyWarned: boolean,
): Promise<NoProgressDecision> {
  // Rounds restart at Resume, which asks for a fresh check: what failed may have been the computer, not the code.
  if (item.round === 0) return { kind: 'continue' };
  const lastFail = [...rows].reverse().find((row) => row.verdict === 'FAIL');
  if (!lastFail) return { kind: 'continue' };
  const current = progressFingerprint(
    item.checkpointCommit,
    await documentContentSha256(item.sourceRef),
    item.round,
  );
  const failed = progressFingerprint(lastFail.worktreeHead, lastFail.documentSha256, lastFail.round);
  if (!progressUnchanged(failed, current)) {
    return { kind: 'continue' };
  }
  if (previouslyWarned) {
    return { kind: 'park', detail: 'Nothing changed since the last check failed.' };
  }
  return { kind: 'reprompt', prompt: NOTHING_CHANGED_PROMPT };
}

/** Findings surviving consecutive failed rounds, once per finding per round. */
export function repeatedFindingIds(
  rows: readonly { verdict: string; findings: readonly { id: string }[] }[],
): { twice: Set<string>; thrice: Set<string> } {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const current = new Set(row.verdict === 'FAIL' ? row.findings.map(finding => finding.id) : []);
    for (const id of counts.keys()) if (!current.has(id)) counts.delete(id);
    for (const id of current) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const twice = new Set<string>();
  const thrice = new Set<string>();
  for (const [id, count] of counts) {
    if (count >= 2) twice.add(id);
    if (count >= 3) thrice.add(id);
  }
  return { twice, thrice };
}

/** Observe before enforcing the round ceiling, including its default third round. */
export function recordRepeatedFindingObservation(history: PlanQueueHistoryStore | undefined, item: PlanQueueItem, round: number) {
  const repeated = repeatedFindingIds(history?.listVerdicts(item.id) ?? []);
  if (repeated.thrice.size) history?.recordEvent({
    itemId: item.id, runId: item.runId, fromState: item.state, toState: item.state,
    reason: 'stuck-on-same-finding',
    detailHead: `Same finding failed in three rounds: ${[...repeated.thrice].slice(0, 3).join(', ')}`,
    round, tokens: 0,
  });
  return repeated;
}

