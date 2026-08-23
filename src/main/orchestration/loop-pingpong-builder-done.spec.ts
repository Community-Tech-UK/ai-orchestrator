import { describe, expect, it, vi } from 'vitest';
import { resolvePingPongBuilderDone } from './loop-pingpong-builder-done';
import type { LoopCleanReviewClassifier } from './loop-clean-review-classifier';
import type { CompletionSignalEvidence } from '../../shared/types/loop.types';

const classifierInput = {
  goal: 'finish the widget',
  workspaceCwd: '/repo',
  iterationOutput: 'I found several remaining issues and will keep going.',
  config: { noOutstandingPhrase: 'There are no outstanding issues' },
};

/** The prose classifier's real-world default: never clean without the sentinel. */
const notClean = (): LoopCleanReviewClassifier =>
  vi.fn().mockResolvedValue({ clean: false, confidence: 0.85, reason: 'unresolved work' });

function signal(partial: Partial<CompletionSignalEvidence>): CompletionSignalEvidence {
  return {
    id: 'ledger-complete',
    sufficient: true,
    detail: 'All 15 LOOP_TASKS.md leaf items resolved (done/deferred) during this run',
    ...partial,
  } as CompletionSignalEvidence;
}

describe('resolvePingPongBuilderDone', () => {
  it('treats a sufficient completion signal as a builder done-declaration', async () => {
    const classify = notClean();
    const verdict = await resolvePingPongBuilderDone([signal({})], classify, classifierInput);

    expect(verdict.clean).toBe(true);
    expect(verdict.signal?.id).toBe('ledger-complete');
    expect(verdict.reason).toContain('ledger-complete');
  });

  it('does not spend a classifier call when a sufficient signal is already present', async () => {
    const classify = notClean();
    await resolvePingPongBuilderDone([signal({})], classify, classifierInput);

    expect(classify).not.toHaveBeenCalled();
  });

  it('ignores insufficient signals and falls back to the prose classifier', async () => {
    const classify = notClean();
    const verdict = await resolvePingPongBuilderDone(
      [signal({ id: 'self-declared', sufficient: false })],
      classify,
      classifierInput,
    );

    expect(verdict.clean).toBe(false);
    expect(verdict.signal).toBeUndefined();
    expect(classify).toHaveBeenCalledOnce();
  });

  it('falls back to the prose classifier when no signals are supplied at all', async () => {
    const classify = notClean();
    const verdict = await resolvePingPongBuilderDone(undefined, classify, classifierInput);

    expect(verdict.clean).toBe(false);
    expect(classify).toHaveBeenCalledOnce();
  });

  it('still honours the sentinel route when the classifier does return clean', async () => {
    const classify = vi.fn().mockResolvedValue({
      clean: true,
      confidence: 1,
      reason: 'structured clean-review sentinel present',
    }) as unknown as LoopCleanReviewClassifier;
    const verdict = await resolvePingPongBuilderDone([], classify, classifierInput);

    expect(verdict.clean).toBe(true);
    expect(verdict.signal).toBeUndefined();
  });
});
