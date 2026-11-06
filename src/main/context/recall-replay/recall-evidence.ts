/**
 * Turns recall-check counts into a yes/no for the own-chat context ceiling.
 *
 * "No cap ships if recall is clearly worse" needs a number for "clearly". These are
 * the implementer's choices, kept in one place so they are easy to see and change:
 *
 *  - pooled over all chats, the score after summarising may be at most 10 points
 *    below the score before (a point is one percent of questions);
 *  - no single chat may lose more than 25 points;
 *  - the "before" score must be at least 50%, otherwise the questions were too hard
 *    to show any loss;
 *  - at least three chats, each with 10-15 questions, each proven to have been
 *    summarised from near the ceiling, and the check no older than a quarter.
 *
 * With three chats of about a dozen questions the pooled score moves by about 3
 * points per question, so the 10-point margin is roughly three questions. It
 * tolerates noise but still refuses a summary that forgets a lot.
 */

import {
  RECALL_MAX_QUESTIONS,
  RECALL_MIN_CHATS,
  RECALL_MIN_PROMPTS,
  RECALL_MIN_QUESTIONS,
  RECALL_TARGET_TOKENS,
  RECALL_VERDICTS,
  emptyTally,
  recallScore,
  tallyTotal,
  type RecallChatResult,
  type RecallEvidence,
  type RecallTally,
  type RecallVerdict,
} from './recall-types';

export const RECALL_MAX_POOLED_DROP = 0.10;
export const RECALL_MAX_CHAT_DROP = 0.25;
export const RECALL_MIN_BASELINE = 0.5;
/** A quarter plus a month's slack: the check is meant to be re-run every quarter. */
export const RECALL_EVIDENCE_MAX_AGE_DAYS = 120;
/** Evidence counts for a ceiling this close to the size it measured. */
export const RECALL_TARGET_SLACK = 0.2;

export type RecallIneligibleReason =
  | 'no-evidence' | 'malformed' | 'too-few-chats' | 'too-few-questions' | 'no-compaction'
  | 'wrong-size' | 'stale' | 'baseline-too-low' | 'recall-worse';

export type RecallEligibility =
  | { eligible: true; pooledBefore: number; pooledAfter: number }
  | { eligible: false; reason: RecallIneligibleReason; detail: string };

export function tallyVerdicts(verdicts: readonly RecallVerdict[]): RecallTally {
  const tally = emptyTally();
  for (const verdict of verdicts) tally[verdict]++;
  return tally;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function validTally(value: unknown): value is RecallTally {
  return isRecord(value) && RECALL_VERDICTS.every(verdict => isCount(value[verdict]));
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
/** Clock difference tolerated between the machine that recorded the check and the one reading it. */
const FUTURE_SLACK_MS = 5 * 60_000;
/** The size the CLI reports just before summarising must be about the size we cut at. */
const PRE_TOKENS_RATIO: readonly [number, number] = [0.65, 1.35];

function validCompaction(value: unknown, cut: number): boolean {
  if (!isRecord(value) || !isCount(value['boundaries'])) return false;
  if (value['boundaries'] === 0) return value['preTokens'] === null && value['postTokens'] === null;
  const pre = value['preTokens'];
  return isSize(pre) && isSize(value['postTokens']) && pre >= cut * PRE_TOKENS_RATIO[0] && pre <= cut * PRE_TOKENS_RATIO[1];
}

function validChat(value: unknown): value is RecallChatResult {
  if (!isRecord(value) || !isKey(value['chatKey']) || !isKey(value['conversationKey'])) return false;
  const cut = value['contextTokensAtCut'];
  const count = value['questionCount'];
  return isSize(cut) && isCount(value['humanPrompts']) && value['humanPrompts'] >= RECALL_MIN_PROMPTS
    && isCount(count) && validTally(value['before']) && validTally(value['after'])
    && tallyTotal(value['before']) === count && tallyTotal(value['after']) === count
    && validCompaction(value['compaction'], cut)
    && typeof value['costUsd'] === 'number' && Number.isFinite(value['costUsd']) && value['costUsd'] >= 0;
}

export function summariseRecall(evidence: RecallEvidence): { chats: number; questions: number; pooledBefore: number; pooledAfter: number } {
  const before = emptyTally();
  const after = emptyTally();
  for (const chat of evidence.chats) for (const verdict of RECALL_VERDICTS) { before[verdict] += chat.before[verdict]; after[verdict] += chat.after[verdict]; }
  return { chats: evidence.chats.length, questions: tallyTotal(before), pooledBefore: recallScore(before), pooledAfter: recallScore(after) };
}

export function buildRecallEvidence(
  chats: readonly RecallChatResult[], model: string, targetTokens: number, now: Date, method: RecallEvidence['method'] = 'cli-replay',
): RecallEvidence {
  return { schema: 1, generatedAt: now.toISOString(), method, model, targetTokens, chats: [...chats] };
}

/** TypeScript source for `own-chat-ceiling-recall-evidence.ts`: counts and sizes only, nothing from any conversation. */
export function renderEvidenceModule(evidence: RecallEvidence): string {
  return [
    '/**',
    ' * The recall check that gates the 300,000-token ceiling for James\'s own Claude chats.',
    ' *',
    ' * Written by `scripts/audit/recall-replay.ts write-evidence`: counts and sizes only, never',
    ' * questions, answers or transcript text. Re-run it every quarter; the migration ignores',
    ' * evidence older than 120 days. `null` means no passing check is recorded.',
    ' */',
    "import type { RecallEvidence } from '../../context/recall-replay/recall-types';",
    '',
    `export const OWN_CHAT_CEILING_RECALL_EVIDENCE: RecallEvidence | null = ${JSON.stringify(evidence, null, 2)};`,
    '',
  ].join('\n');
}

const no = (reason: RecallIneligibleReason, detail: string): RecallEligibility => ({ eligible: false, reason, detail });

/** Never throws: anything unusable is simply "not eligible". */
export function evaluateRecallEvidence(input: unknown, now: Date): RecallEligibility {
  if (input === null || input === undefined) return no('no-evidence', 'No recall check has been recorded.');
  if (!isRecord(input) || input['schema'] !== 1 || input['method'] !== 'cli-replay' || !Array.isArray(input['chats'])
    || typeof input['generatedAt'] !== 'string' || !isSize(input['targetTokens'])
    || typeof input['model'] !== 'string' || !input['model'].trim() || input['model'].length > 100) {
    return no('malformed', 'The recall record is not in the expected shape.');
  }
  const generated = Date.parse(input['generatedAt']);
  if (!Number.isFinite(generated)) return no('malformed', 'The recall record has no valid date.');
  if (generated > now.getTime() + FUTURE_SLACK_MS) return no('malformed', 'The recall record is dated in the future.');
  if (!input['chats'].every(validChat)) return no('malformed', 'A chat result has missing or impossible counts or sizes.');
  const evidence = input as unknown as RecallEvidence;
  if (new Set(evidence.chats.map(chat => chat.chatKey)).size !== evidence.chats.length
    || new Set(evidence.chats.map(chat => chat.conversationKey)).size !== evidence.chats.length) {
    return no('malformed', 'The same chat appears more than once.');
  }

  if (now.getTime() - generated > RECALL_EVIDENCE_MAX_AGE_DAYS * 86_400_000) return no('stale', `The recall check is older than ${RECALL_EVIDENCE_MAX_AGE_DAYS} days.`);
  if (evidence.chats.length < RECALL_MIN_CHATS) return no('too-few-chats', `Needs ${RECALL_MIN_CHATS} chats, has ${evidence.chats.length}.`);
  if (evidence.chats.some(chat => chat.questionCount < RECALL_MIN_QUESTIONS || chat.questionCount > RECALL_MAX_QUESTIONS)) {
    return no('too-few-questions', `Each chat needs ${RECALL_MIN_QUESTIONS}-${RECALL_MAX_QUESTIONS} questions.`);
  }
  const low = RECALL_TARGET_TOKENS * (1 - RECALL_TARGET_SLACK);
  const high = RECALL_TARGET_TOKENS * (1 + RECALL_TARGET_SLACK);
  if (evidence.targetTokens < low || evidence.targetTokens > high || evidence.chats.some(chat => chat.contextTokensAtCut < low || chat.contextTokensAtCut > high)) {
    return no('wrong-size', 'The check was not run near the 300,000-token ceiling.');
  }
  if (evidence.chats.some(chat => chat.compaction.boundaries < 1 || chat.compaction.postTokens === null || chat.compaction.postTokens >= chat.contextTokensAtCut)) {
    return no('no-compaction', 'A chat was not shown to be summarised down from its full size.');
  }
  const { pooledBefore, pooledAfter } = summariseRecall(evidence);
  if (pooledBefore < RECALL_MIN_BASELINE) return no('baseline-too-low', 'Even with the full chat the questions were answered too rarely to show a loss.');
  const worstChat = Math.max(...evidence.chats.map(chat => recallScore(chat.before) - recallScore(chat.after)));
  if (pooledBefore - pooledAfter > RECALL_MAX_POOLED_DROP + 1e-9 || worstChat > RECALL_MAX_CHAT_DROP + 1e-9) {
    return no('recall-worse', `Recall fell from ${(pooledBefore * 100).toFixed(0)}% to ${(pooledAfter * 100).toFixed(0)}% (worst chat lost ${(worstChat * 100).toFixed(0)} points).`);
  }
  return { eligible: true, pooledBefore, pooledAfter };
}
