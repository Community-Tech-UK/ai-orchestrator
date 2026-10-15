import { describe, expect, it } from 'vitest';
import { describeLoopEnd } from './loop-end-wording';
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
});
