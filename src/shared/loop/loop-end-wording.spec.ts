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
it('names why nothing was merged for the stall and final-check holds', () => {
  expect(describeLoopEnd({ status: 'completed-needs-review', mergeHeld: true, mergeHoldKind: 'stalled', branch: 'loop/task', roundsFinished: 3, endedAt: 1000 }).sentence).toContain('the loop stalled');
  expect(describeLoopEnd({ status: 'completed-needs-review', mergeHeld: true, mergeHoldKind: 'final-audit-blocked', branch: 'loop/task', roundsFinished: 3, endedAt: 1000 }).sentence).toContain('final check needs your sign-off');
  expect(describeLoopEnd({ status: 'completed-needs-review', mergeHeld: true, mergeHoldKind: 'stalled', branch: 'loop/task', roundsFinished: 3, endedAt: 1000 }).sentence).toContain('loop/task');
});

it('keeps passed-audit no-change review distinct from restored historical final-audit holds', () => {
  const input = { status: 'completed-needs-review', mergeHeld: true, branch: 'loop/kept', roundsFinished: 3, endedAt: 1000 };
  const noChange = describeLoopEnd({ ...input, mergeHoldKind: 'verified-no-change' });
  expect(noChange.sentence).toContain('no production changes and needs your review');
  expect(noChange.sentence).toContain('loop/kept');
  expect(noChange.sentence).not.toContain('final check needs your sign-off');
  const restored = JSON.parse(JSON.stringify({ mergeHoldKind: 'final-audit-blocked' })) as { mergeHoldKind: string };
  expect(describeLoopEnd({ ...input, ...restored }).sentence).toContain('final check needs your sign-off');
});


it.each([undefined, 'historical-kind', ''])('keeps an unrecorded hold reason factual (%s)', (mergeHoldKind) => {
  const end = describeLoopEnd({
    status: 'completed-needs-review', mergeHeld: true, mergeHoldKind,
    branch: 'loop/kept', roundsFinished: 3, endedAt: 1000,
  });
  expect(end.sentence).toContain('Nothing was merged because the work is held for review.');
  expect(end.sentence).toContain('loop/kept');
  expect(end.sentence).not.toContain('skipped');
});
