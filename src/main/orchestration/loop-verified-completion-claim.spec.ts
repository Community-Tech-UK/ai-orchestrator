import { describe, expect, it } from 'vitest';
import type { LoopIteration } from '../../shared/types/loop.types';
import { isVerifiedNoChangeCompletionClaim } from './loop-verified-completion-claim';

describe('isVerifiedNoChangeCompletionClaim', () => {
  it('rejects a verified subtask completion when the agent explicitly declares more work remains', () => {
    const output = [
      'Completed WS2 and verified it with 152 passing tests.',
      'WS3-WS16 remain in the loop ledger.',
      '[[LOOP:MORE_WORK_REMAINING]]',
    ].join('\n');

    expect(isVerifiedNoChangeCompletionClaim({
      outputFull: output,
      outputExcerpt: output,
      verifyStatus: 'skipped',
      testPassCount: 152,
      testFailCount: 0,
    } as unknown as LoopIteration)).toBe(false);
  });
});
