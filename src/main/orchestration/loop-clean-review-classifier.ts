import type { LoopCompletionConfig } from '../../shared/types/loop.types';

export interface LoopCleanReviewClassifierInput {
  goal: string;
  workspaceCwd: string;
  iterationOutput: string;
  config: Pick<LoopCompletionConfig, 'noOutstandingPhrase'>;
}

export interface LoopCleanReviewClassification {
  clean: boolean;
  confidence: number;
  reason: string;
}

export type LoopCleanReviewClassifier = (
  input: LoopCleanReviewClassifierInput,
) => Promise<LoopCleanReviewClassification>;

export const UNCLEAR_CLEAN_REVIEW: LoopCleanReviewClassification = {
  clean: false,
  confidence: 0,
  reason: 'clean-review sentiment unclear',
};

export const DEFAULT_CLEAN_REVIEW_TIMEOUT_MS = 20_000;

export const defaultCleanReviewClassifier: LoopCleanReviewClassifier = async (input) => {
  const deterministic = classifyCleanReviewText(input.iterationOutput, input.config.noOutstandingPhrase);
  if (deterministic.confidence >= 0.9) return deterministic;

  const model = await withCleanReviewTimeout(runModelCleanReviewClassifier(input), DEFAULT_CLEAN_REVIEW_TIMEOUT_MS);
  if (model.confidence >= 0.6) return model;

  return deterministic.confidence > 0 ? deterministic : model;
};

async function runModelCleanReviewClassifier(
  input: LoopCleanReviewClassifierInput,
): Promise<LoopCleanReviewClassification> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLLMService } = require('../rlm/llm-service') as typeof import('../rlm/llm-service');
    const llm = getLLMService();
    if (!(await llm.isAvailable())) return UNCLEAR_CLEAN_REVIEW;

    const context = [
      `GOAL:\n${input.goal}`,
      `WORKSPACE:\n${input.workspaceCwd}`,
      `REVIEW OUTPUT:\n${input.iterationOutput.slice(0, 5000)}`,
    ].join('\n\n');
    const prompt =
      'Classify whether the REVIEW OUTPUT says there are no actionable issues, ' +
      'no remaining work, and nothing left to fix for the GOAL. Do not require ' +
      'any exact phrase; judge the sentiment. Return ONLY JSON:\n' +
      '{"clean": <true|false>, "confidence": <number 0..1>, "reason": "<short sentence>"}\n' +
      'Return clean=false for vague shipping confidence, unresolved work, blocked/cannot-verify language, or ambiguity.';

    const raw = await llm.subQuery({
      requestId: `loop-clean-review-${Date.now()}`,
      prompt,
      context,
      depth: 0,
    });
    return parseCleanReviewClassification(raw);
  } catch {
    return UNCLEAR_CLEAN_REVIEW;
  }
}

export function parseCleanReviewClassification(raw: string): LoopCleanReviewClassification {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return UNCLEAR_CLEAN_REVIEW;
    const obj = JSON.parse(match[0]) as Partial<LoopCleanReviewClassification>;
    if (typeof obj.clean !== 'boolean') return UNCLEAR_CLEAN_REVIEW;
    const confidenceRaw = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? obj.confidence
      : 0;
    const confidence = Math.max(0, Math.min(1, confidenceRaw));
    const reason = typeof obj.reason === 'string' && obj.reason.trim()
      ? obj.reason.trim().slice(0, 300)
      : 'model clean-review classification';
    return { clean: obj.clean, confidence, reason };
  } catch {
    return UNCLEAR_CLEAN_REVIEW;
  }
}

export function classifyCleanReviewText(
  raw: string,
  noOutstandingPhrase = 'There are no outstanding issues',
): LoopCleanReviewClassification {
  const text = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return UNCLEAR_CLEAN_REVIEW;

  const phrase = noOutstandingPhrase.trim().toLowerCase();
  if (phrase && text.includes(phrase)) {
    return { clean: true, confidence: 1, reason: 'configured no-outstanding phrase present' };
  }

  const cleanPatterns = [
    /\b(no|zero)\s+(actionable\s+)?(remaining\s+|outstanding\s+)?(issues|problems|blockers|findings|tasks|work|fixes)\b/,
    /\b(nothing|no work)\s+(left|remaining|outstanding)\s+(to\s+)?(fix|do|address|change)\b/,
    /\b(did not|didn't|could not|couldn't|cannot|can't)\s+find\s+(any\s+)?(actionable\s+)?(issues|problems|blockers|findings|remaining work)\b/,
    /\bfound\s+no\s+(actionable\s+)?(issues|problems|blockers|findings|remaining work)\b/,
    /\ball\s+clear\b/,
  ];
  if (cleanPatterns.some((pattern) => pattern.test(text))) {
    return { clean: true, confidence: 0.8, reason: 'review output says no actionable work remains' };
  }

  const unresolvedPatterns = [
    /\b(still|outstanding)\s+(need|needs|needed|work|task|tasks|issue|issues|problem|problems|fix|fixes)\b/,
    /\bremaining\s+(task|tasks|issue|issues|problem|problems|fix|fixes)\b/,
    /\b(found|identified|discovered)\s+([1-9]\d*|one|some|several|multiple)\s+(issue|issues|problem|problems|bug|bugs|blocker|blockers)\b/,
    /\b(needs?|requires?|must|should)\s+(be\s+)?(fixed|implemented|changed|verified|reviewed)\b/,
    /\b(blocked|blocker|cannot verify|can't verify|could not verify|unable to verify|not verified|not complete|incomplete)\b/,
    /\b(todo|follow-up required|manual action required)\b/,
  ];
  if (unresolvedPatterns.some((pattern) => pattern.test(text))) {
    return { clean: false, confidence: 0.85, reason: 'review mentions unresolved work or verification gaps' };
  }

  return UNCLEAR_CLEAN_REVIEW;
}

export function withCleanReviewTimeout(
  operation: Promise<LoopCleanReviewClassification>,
  timeoutMs: number,
): Promise<LoopCleanReviewClassification> {
  return new Promise<LoopCleanReviewClassification>((resolve) => {
    let settled = false;
    const finish = (result: LoopCleanReviewClassification): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(UNCLEAR_CLEAN_REVIEW), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    operation.then(finish, () => finish(UNCLEAR_CLEAN_REVIEW));
  });
}
