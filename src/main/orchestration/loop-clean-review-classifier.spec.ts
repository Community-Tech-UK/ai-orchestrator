import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  defaultCleanReviewClassifier,
  CLEAN_REVIEW_SENTINEL,
  __setCleanReviewModelBackendsForTesting,
  __resetCleanReviewModelBackendsForTesting,
} from './loop-clean-review-classifier';

const AMBIGUOUS_INPUT = {
  goal: 'Ship the feature',
  workspaceCwd: '/work',
  // Deliberately ambiguous so the deterministic regex classifier yields low
  // confidence and the model (auxiliary) path is exercised.
  iterationOutput: 'Made some progress and things are looking decent so far.',
  config: { noOutstandingPhrase: 'There are no outstanding issues' },
};

describe('loop clean-review classifier — loopScoring offload', () => {
  let aux: ReturnType<typeof vi.fn>;
  let frontier: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    aux = vi.fn();
    frontier = vi.fn();
    __setCleanReviewModelBackendsForTesting({ aux, frontier });
  });

  afterEach(() => {
    __resetCleanReviewModelBackendsForTesting();
  });

  it('uses the auxiliary (local) model result when it produces a classification', async () => {
    aux.mockResolvedValue({
      text: '{"clean": false, "confidence": 0.8, "reason": "work remains"}',
      source: 'local',
      allowFrontierFallback: false,
    });

    const result = await defaultCleanReviewClassifier(AMBIGUOUS_INPUT);

    expect(aux).toHaveBeenCalledWith(expect.any(String), expect.any(String));
    expect(result.clean).toBe(false);
    expect(result.confidence).toBeCloseTo(0.8);
    // Must NOT touch the frontier/primary LLM when local produced a result.
    expect(frontier).not.toHaveBeenCalled();
  });

  it('does NOT escalate to the frontier LLM when local is unavailable and frontier fallback is disallowed', async () => {
    aux.mockResolvedValue({ text: '', source: 'fallback', allowFrontierFallback: false });

    const result = await defaultCleanReviewClassifier(AMBIGUOUS_INPUT);

    expect(aux).toHaveBeenCalledTimes(1);
    expect(result.clean).toBe(false); // UNCLEAR
    expect(frontier).not.toHaveBeenCalled();
  });

  it('escalates to the frontier LLM only when the slot allows frontier fallback', async () => {
    aux.mockResolvedValue({ text: '', source: 'fallback', allowFrontierFallback: true });
    frontier.mockResolvedValue('{"clean": false, "confidence": 0.9, "reason": "frontier"}');

    const result = await defaultCleanReviewClassifier(AMBIGUOUS_INPUT);

    expect(aux).toHaveBeenCalledTimes(1);
    expect(frontier).toHaveBeenCalledTimes(1);
    expect(result.clean).toBe(false);
    expect(result.reason).toBe('frontier');
  });

  it('falls back to the frontier LLM when the auxiliary backend throws', async () => {
    aux.mockRejectedValue(new Error('aux exploded'));
    frontier.mockResolvedValue('{"clean": false, "confidence": 0.7, "reason": "frontier saw work"}');

    const result = await defaultCleanReviewClassifier(AMBIGUOUS_INPUT);

    expect(frontier).toHaveBeenCalledTimes(1);
    expect(result.clean).toBe(false);
    expect(result.reason).toBe('frontier saw work');
  });

  it('short-circuits on the deterministic classifier and never calls a model when the verdict is high-confidence', async () => {
    const result = await defaultCleanReviewClassifier({
      ...AMBIGUOUS_INPUT,
      iterationOutput: `There are no outstanding issues.\n${CLEAN_REVIEW_SENTINEL}`,
    });

    expect(result.clean).toBe(true);
    expect(result.confidence).toBe(1);
    expect(aux).not.toHaveBeenCalled();
    expect(frontier).not.toHaveBeenCalled();
  });

  it('does not treat the natural-language clean phrase as a terminal declaration', async () => {
    aux.mockResolvedValue({ text: '', source: 'fallback', allowFrontierFallback: false });

    const result = await defaultCleanReviewClassifier({
      ...AMBIGUOUS_INPUT,
      iterationOutput: 'There are no outstanding issues',
    });

    expect(result.clean).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it('rejects a quoted or stale clean sentinel', async () => {
    aux.mockResolvedValue({ text: '', source: 'fallback', allowFrontierFallback: false });
    const quoted = await defaultCleanReviewClassifier({
      ...AMBIGUOUS_INPUT,
      iterationOutput: `The token ${CLEAN_REVIEW_SENTINEL} is reserved for a clean pass.`,
    });
    const stale = await defaultCleanReviewClassifier({
      ...AMBIGUOUS_INPUT,
      iterationOutput: [
        CLEAN_REVIEW_SENTINEL,
        ...Array.from({ length: 13 }, (_, i) => `later line ${i + 1}`),
      ].join('\n'),
    });

    expect(quoted.clean).toBe(false);
    expect(stale.clean).toBe(false);
  });
});
