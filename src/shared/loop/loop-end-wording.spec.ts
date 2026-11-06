import { describe, expect, it } from 'vitest';
import { describeLoopEnd } from './loop-end-wording';
import { harnessStopLoopEndReason } from '../utils/harness-stop';
describe('loop end wording', () => {
  it.each(['completed','completed-needs-review','attempt-failed','cancelled','cap-reached','cost-exceeded','error','no-progress','provider-limit','needs-human-arbitration','reviewer-unreliable','reviewer-unavailable','builder-unreliable'])('gives %s a plain headline with no internal codes', (status) => {
    for (const endReason of ['signal=done-promise', 'cap=iterations; after 50 iteration(s); no completion was attempted', 'user cancelled', 'app-restart']) {
      const end = describeLoopEnd({ status, endReason, roundsFinished: 50, endedAt: 1000 });
      expect(end.headline).not.toMatch(/signal=|cap=/); expect(end.sentence).not.toMatch(/signal=|cap=/);
    }
  });
  it('retains the first plain sentence and gives held branches a visible consequence', () => {
    expect(describeLoopEnd({ status: 'error', endReason: 'The compiler crashed. Full details below.', roundsFinished: 3, endedAt: 1000 }).sentence).toBe('The compiler crashed.');
    expect(describeLoopEnd({ status: 'completed-needs-review', mergeHeld: true, branch: 'loop/task', roundsFinished: 3, endedAt: 1000 }).sentence).toContain('Nothing was merged');
    expect(describeLoopEnd({ status: 'completed-needs-review', mergeHeld: true, branch: 'loop/task', roundsFinished: 3, endedAt: 1000 }).sentence).toContain('loop/task');
  });
  it('says Harness stopped the loop at the Codex round limit, not that an error stopped it', () => {
    const endReason = harnessStopLoopEndReason({ reason: 'turn-token-ceiling', tokens: 300_000_123, thresholdTokens: 300_000_000 });
    const end = describeLoopEnd({ status: 'error', endReason, roundsFinished: 4, endedAt: 1000 });
    expect(end.headline).toBe('Stopped by Harness at the Codex round limit');
    expect(end.sentence).toBe('Harness stopped this loop: a Codex round passed 300M tokens, and running it again would likely spend the same, so it was not retried.');
    expect(endReason).toContain('Stop point for Harness work');
  });
});
