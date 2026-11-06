/**
 * Types and constants for the long-chat recall check.
 *
 * The check asks: after Claude summarises a long chat at about 300K tokens, can it
 * still answer questions about earlier detail as well as it could before? Results
 * are kept as counts only. Transcript text, questions and answers never enter these
 * types, so a result can be stored in the repository and shown to anyone.
 */

/** Context size the own-chat ceiling would summarise at. */
export const RECALL_TARGET_TOKENS = 300_000;

/** A cut counts as "near 300K" when it lands within this share below the target. */
export const RECALL_CUT_TOLERANCE = 0.15;

export const RECALL_MIN_QUESTIONS = 10;
export const RECALL_MAX_QUESTIONS = 15;
export const RECALL_MIN_CHATS = 3;
/** Typed prompts a chat needs to count as a real conversation rather than a machine session. */
export const RECALL_MIN_PROMPTS = 20;

export type RecallVerdict = 'correct' | 'partial' | 'wrong' | 'unknown';

export const RECALL_VERDICTS: readonly RecallVerdict[] = ['correct', 'partial', 'wrong', 'unknown'];

export type RecallTally = Record<RecallVerdict, number>;

export interface RecallQuestion {
  question: string;
  /** Short expected answer, taken from the conversation. */
  answer: string;
  /** Verbatim quote from the conversation that supports the answer. */
  evidence: string;
}

/** What happened to one chat. Counts and sizes only. */
export interface RecallChatResult {
  /** Short hash of the source transcript path; not reversible to a path or content. */
  chatKey: string;
  /**
   * Short hash of the API message id at the cut. Copies and resumed forks of one conversation share
   * it, so three copies of one chat cannot pass as three chats.
   */
  conversationKey: string;
  /** Context size at the cut, from the model's own usage figures. */
  contextTokensAtCut: number;
  /** Human prompts in the conversation up to the cut. */
  humanPrompts: number;
  questionCount: number;
  before: RecallTally;
  after: RecallTally;
  compaction: {
    boundaries: number;
    preTokens: number | null;
    postTokens: number | null;
  };
  costUsd: number;
}

/** A finished recall check. This is what the migration gate reads. */
export interface RecallEvidence {
  schema: 1;
  /** ISO timestamp the check finished. */
  generatedAt: string;
  /**
   * `cli-replay`: summarised exactly as the app does. `cli-replay-custom-compact`: summarised with extra instructions the
   * app does not send; informative only, and never accepted by the release gate.
   */
  method: 'cli-replay' | 'cli-replay-custom-compact';
  /** Model that answered and summarised, as the CLI reported it. */
  model: string;
  /** Context size the cut aimed for. */
  targetTokens: number;
  chats: RecallChatResult[];
}

export const emptyTally = (): RecallTally => ({ correct: 0, partial: 0, wrong: 0, unknown: 0 });

export const tallyTotal = (tally: RecallTally): number => RECALL_VERDICTS.reduce((sum, verdict) => sum + tally[verdict], 0);

/** Share of questions answered correctly; a partial answer counts half. */
export function recallScore(tally: RecallTally): number {
  const total = tallyTotal(tally);
  return total === 0 ? 0 : (tally.correct + 0.5 * tally.partial) / total;
}
