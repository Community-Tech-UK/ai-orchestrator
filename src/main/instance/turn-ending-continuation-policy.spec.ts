import { describe, expect, it } from 'vitest';
import { TurnEndingClassificationSchema } from '@contracts/schemas/provider-runtime-events';
import type { ProviderTurnEndingReason } from '@contracts/types/provider-runtime-events';
import {
  CONTENT_FILTER_NOTICE,
  CONTINUATION_DISPATCH_POLICY,
  REASONING_COLLAPSE_NOTICE,
  TURN_CONTINUATION_POLICY,
  turnContinuationPolicy,
  turnNoticeMetadata,
} from './turn-ending-continuation-policy';

const KEPT = 'Your message and the work above are kept.';
const reasons = Object.keys(TURN_CONTINUATION_POLICY) as ProviderTurnEndingReason[];

describe('turn-ending notice table', () => {
  it('has an entry for every reason the contract allows, and no others', () => {
    expect([...TurnEndingClassificationSchema.shape.reason.options].sort()).toEqual([...reasons].sort());
  });

  it('knows about a model that sent no reply', () => {
    expect(TURN_CONTINUATION_POLICY.empty_result.notice).toBe(`The model sent no reply. ${KEPT}`);
    // Re-asking an empty model is the user's choice, never an automatic prompt.
    expect(TURN_CONTINUATION_POLICY.empty_result.prompt).toBeUndefined();
  });

  it.each(reasons)('says whether the message and the work were kept: %s', reason => {
    expect(TURN_CONTINUATION_POLICY[reason].notice).toContain(KEPT);
  });

  it('says the same for the reasoning-collapse variant and the exported notices', () => {
    expect(turnContinuationPolicy('max_output', true).notice).toContain(KEPT);
    expect(REASONING_COLLAPSE_NOTICE).toContain(KEPT);
    expect(CONTENT_FILTER_NOTICE).toContain(KEPT);
  });

  it('keeps what the user reads apart from what the model is told', () => {
    for (const reason of reasons) {
      const { notice, prompt } = turnContinuationPolicy(reason, reason === 'max_output');
      if (!prompt) continue;
      expect(notice, reason).not.toBe(prompt);
      // The model prompt speaks to the model; it never carries the user-facing reassurance.
      expect(prompt, reason).not.toContain(KEPT);
      // And the user notice is not an instruction.
      expect(notice, reason).not.toMatch(/^(pick|resume|continue|do not)\b/i);
    }
  });

  it('offers a next step as structured data, not as words in the notice', () => {
    expect(TURN_CONTINUATION_POLICY.crash.action).toBe('continue');
    expect(TURN_CONTINUATION_POLICY.max_output.action).toBe('continue');
    expect(TURN_CONTINUATION_POLICY.content_filter.action).toBe('continue');
    expect(TURN_CONTINUATION_POLICY.truncated_transport.action).toBe('retry');
    expect(TURN_CONTINUATION_POLICY.unknown_error.action).toBe('retry');
    expect(TURN_CONTINUATION_POLICY.empty_result.action).toBe('retry');
    expect(TURN_CONTINUATION_POLICY.auth.action).toBe('sign-in');
    expect(TURN_CONTINUATION_POLICY.quota.action).toBe('switch-model');
    expect(TURN_CONTINUATION_POLICY.billing.action).toBe('switch-model');
    expect(TURN_CONTINUATION_POLICY.completed.action).toBeUndefined();
    expect(turnContinuationPolicy('max_output', true).action).toBe('continue');
  });

  it('never offers sign in except for an authentication stop', () => {
    expect(reasons.filter(reason => TURN_CONTINUATION_POLICY[reason].action === 'sign-in')).toEqual(['auth']);
  });

  it('builds the message metadata from the source and the action only', () => {
    expect(turnNoticeMetadata(TURN_CONTINUATION_POLICY.crash)).toEqual({ source: 'crash-turn-continuation', action: 'continue' });
    expect(turnNoticeMetadata(TURN_CONTINUATION_POLICY.doom_loop)).toEqual({ source: 'doom-loop' });
  });

  it('leaves the automatic-continuation budgets as they were', () => {
    expect(CONTINUATION_DISPATCH_POLICY.cutoff.limit).toBe(2);
  });
});
