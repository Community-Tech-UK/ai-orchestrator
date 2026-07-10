import type { LoopCompletionConfig } from '../../shared/types/loop.types';
import {
  CLEAN_REVIEW_SENTINEL,
  hasTerminalSentinelLine,
} from './loop-terminal-sentinels';

export { CLEAN_REVIEW_SENTINEL } from './loop-terminal-sentinels';

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
  if (!model.clean && model.confidence >= 0.6) return model;

  return deterministic.clean ? UNCLEAR_CLEAN_REVIEW : deterministic;
};

/** Result of the auxiliary (local) backend for clean-review classification. */
interface CleanReviewAuxResult {
  text: string;
  source: string;
  allowFrontierFallback: boolean;
}
type CleanReviewAuxBackend = (prompt: string, context: string) => Promise<CleanReviewAuxResult>;
/** Frontier/primary backend. Returns null when unavailable. */
type CleanReviewFrontierBackend = (prompt: string, context: string) => Promise<string | null>;

// Production backends use lazy require() so worker contexts never eagerly pull in
// electron-laden modules (auxiliary-llm-service → remote-node → settings-manager).
// They are injectable for tests via __setCleanReviewModelBackendsForTesting,
// mirroring the seam convention used elsewhere (e.g. auxiliary-llm-service).
const defaultAuxBackend: CleanReviewAuxBackend = async (prompt, context) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAuxiliaryLlmService } = require('../rlm/auxiliary-llm-service') as typeof import('../rlm/auxiliary-llm-service');
  const { text, decision } = await getAuxiliaryLlmService().generate('loopScoring', prompt, context);
  return { text, source: decision.source, allowFrontierFallback: decision.allowFrontierFallback };
};

const defaultFrontierBackend: CleanReviewFrontierBackend = async (prompt, context) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getLLMService } = require('../rlm/llm-service') as typeof import('../rlm/llm-service');
  const llm = getLLMService();
  if (!(await llm.isAvailable())) return null;
  return llm.subQuery({ requestId: `loop-clean-review-${Date.now()}`, prompt, context, depth: 0 });
};

let auxBackend: CleanReviewAuxBackend = defaultAuxBackend;
let frontierBackend: CleanReviewFrontierBackend = defaultFrontierBackend;

/** Test-only: override the model backends. */
export function __setCleanReviewModelBackendsForTesting(backends: {
  aux?: CleanReviewAuxBackend;
  frontier?: CleanReviewFrontierBackend;
}): void {
  if (backends.aux) auxBackend = backends.aux;
  if (backends.frontier) frontierBackend = backends.frontier;
}

/** Test-only: restore production backends. */
export function __resetCleanReviewModelBackendsForTesting(): void {
  auxBackend = defaultAuxBackend;
  frontierBackend = defaultFrontierBackend;
}

async function runModelCleanReviewClassifier(
  input: LoopCleanReviewClassifierInput,
): Promise<LoopCleanReviewClassification> {
  const context = [
    `GOAL:\n${input.goal}`,
    `WORKSPACE:\n${input.workspaceCwd}`,
    `REVIEW OUTPUT:\n${input.iterationOutput.slice(0, 5000)}`,
  ].join('\n\n');
  const prompt =
    'Classify whether the REVIEW OUTPUT says there are no actionable issues, ' +
    'no remaining work, and nothing left to fix for the GOAL. Do not require ' +
    'any exact phrase; judge the sentiment. Return ONLY JSON (no markdown fences, no other text):\n' +
    '{"clean": <true|false>, "confidence": <number 0..1>, "reason": "<short sentence>"}\n' +
    'Example: {"clean": false, "confidence": 0.8, "reason": "Review lists two unresolved findings"}\n' +
    'Return clean=false for vague shipping confidence, unresolved work, blocked/cannot-verify language, or ambiguity.';

  // Prefer the auxiliary (local) model for this low-stakes semantic check — this
  // is the `loopScoring` offload slot. Only escalate to the primary/frontier LLM
  // when the slot's frontier-fallback policy allows it (i.e. no local model was
  // available and the user hasn't opted into a hard local-only guarantee).
  try {
    const aux = await auxBackend(prompt, context);
    if (aux.source !== 'fallback') {
      return parseCleanReviewClassification(aux.text);
    }
    if (!aux.allowFrontierFallback) {
      // Local unavailable and frontier disallowed for this slot → stay unclear
      // rather than burning a frontier call. The caller folds this back into the
      // deterministic verdict.
      return UNCLEAR_CLEAN_REVIEW;
    }
    // else: fall through to the frontier/primary LLM below.
  } catch {
    // Auxiliary service unavailable in this context — fall through to primary LLM.
  }

  try {
    const raw = await frontierBackend(prompt, context);
    if (raw == null) return UNCLEAR_CLEAN_REVIEW;
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
  if (hasTerminalSentinelLine(raw, CLEAN_REVIEW_SENTINEL)) {
    return { clean: true, confidence: 1, reason: 'structured clean-review sentinel present' };
  }

  const text = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return UNCLEAR_CLEAN_REVIEW;

  const naturalCleanPatterns = [
    noOutstandingPhrase.trim().toLowerCase(),
    'no actionable issues',
    'nothing left to fix',
    'all clear',
  ].filter(Boolean);
  if (naturalCleanPatterns.some((phrase) => text.includes(phrase))) {
    return UNCLEAR_CLEAN_REVIEW;
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
