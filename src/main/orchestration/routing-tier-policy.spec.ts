/**
 * The load-bearing property here is the FIRST test: the shipped defaults must
 * reproduce the previously-hardcoded tiers exactly. If someone "tidies" the
 * defaults, orchestration spend moves silently, which is precisely the class of
 * bug the claude-fanout audit was written to catch.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    getAll: () => ({
      orchestrationRoutingPolicyJson: '{"review":"fast","debateSynthesis":"powerful"}',
    }),
  })),
}));

import {
  DEFAULT_ORCHESTRATION_ROUTING_POLICY_JSON,
  DEFAULT_ORCHESTRATION_ROUTING_POLICY,
} from '../../shared/types/settings.types';
import { parseRoutingTierPolicy, resolveRoutingPolicyTier } from './routing-tier-policy';

describe('routing tier policy', () => {
  it('defaults reproduce the previously-hardcoded tiers (behaviour-neutral port)', () => {
    // Before this setting existed, resolveModelForInvocation pinned
    // loop/scaffolding/synthesis to 'balanced' and left workflow on keyword
    // routing. verify/review/debate all mapped to 'scaffolding'.
    expect(DEFAULT_ORCHESTRATION_ROUTING_POLICY).toEqual({
      loop: 'balanced',
      workflow: 'auto',
      verify: 'balanced',
      review: 'balanced',
      debate: 'balanced',
      debateSynthesis: 'balanced',
    });

    expect(parseRoutingTierPolicy(DEFAULT_ORCHESTRATION_ROUTING_POLICY_JSON)).toEqual(
      DEFAULT_ORCHESTRATION_ROUTING_POLICY,
    );

    // 'auto' means "defer to the keyword heuristic" and must resolve to undefined.
    expect(resolveRoutingPolicyTier('workflow', DEFAULT_ORCHESTRATION_ROUTING_POLICY_JSON)).toBeUndefined();
    expect(resolveRoutingPolicyTier('loop', DEFAULT_ORCHESTRATION_ROUTING_POLICY_JSON)).toBe('balanced');
    // Guard the audit finding: synthesis must not default to the powerful tier.
    expect(resolveRoutingPolicyTier('debateSynthesis', DEFAULT_ORCHESTRATION_ROUTING_POLICY_JSON))
      .not.toBe('powerful');
  });

  it('applies per-gate overrides, which is the whole point', () => {
    // The motivating case: push the bounded, read-only gates onto a cheap model
    // without touching the loop that does the actual work.
    const raw = JSON.stringify({ verify: 'fast', review: 'fast' });

    expect(resolveRoutingPolicyTier('verify', raw)).toBe('fast');
    expect(resolveRoutingPolicyTier('review', raw)).toBe('fast');
    expect(resolveRoutingPolicyTier('loop', raw)).toBe('balanced'); // untouched
  });

  it('reads from settings when no raw policy is passed', () => {
    expect(resolveRoutingPolicyTier('review')).toBe('fast');
    expect(resolveRoutingPolicyTier('debateSynthesis')).toBe('powerful');
    // A key absent from the settings blob keeps its default.
    expect(resolveRoutingPolicyTier('loop')).toBe('balanced');
  });

  it('falls back PER KEY on invalid values rather than discarding the whole policy', () => {
    const raw = JSON.stringify({ verify: 'tiny', review: 'fast', debate: null });

    expect(parseRoutingTierPolicy(raw)).toEqual({
      loop: 'balanced',
      workflow: 'auto',
      verify: 'balanced', // 'tiny' is not a tier -> default
      review: 'fast', // valid -> honoured
      debate: 'balanced', // null -> default
      debateSynthesis: 'balanced',
    });
  });

  it('never throws on a malformed setting — a typo must not take orchestration down', () => {
    for (const raw of ['', '   ', 'not json', '[]', 'null', '42', '{"loop":', undefined, null, 7]) {
      expect(parseRoutingTierPolicy(raw)).toEqual(DEFAULT_ORCHESTRATION_ROUTING_POLICY);
    }
  });

  it('ignores unknown gate names instead of crashing', () => {
    expect(parseRoutingTierPolicy(JSON.stringify({ nonsense: 'fast', review: 'powerful' })))
      .toEqual({ ...DEFAULT_ORCHESTRATION_ROUTING_POLICY, review: 'powerful' });
  });
});
