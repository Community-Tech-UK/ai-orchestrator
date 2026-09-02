import { describe, expect, it, vi } from 'vitest';

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      // Every provider has an entry by default (DEFAULT_REVIEWER_MODEL_BY_PROVIDER),
      // which is exactly why the policy must not blindly copy it onto a panel.
      crossModelReviewModelByProvider: { claude: 'sonnet', codex: 'gpt-5.6-terra' },
      copilotAccountProfiles: [],
      copilotAccountRoutingRules: [],
    }),
  }),
}));

import { applyConsensusCheckingPolicy } from './consensus-checking-policy';
import type { ConsensusProviderSpec } from './consensus.types';

describe('applyConsensusCheckingPolicy', () => {
  it('does NOT pin a model it did not choose', () => {
    // Regression: copying `candidate.model` unconditionally let the REVIEWER
    // setting (`crossModelReviewModelByProvider`) silently take over general
    // consensus queries, which callers never opted into.
    const panel: ConsensusProviderSpec[] = [{ provider: 'claude' }, { provider: 'codex' }];

    const result = applyConsensusCheckingPolicy(panel, '/no/copilot/scope');

    expect(result.panel).toEqual([{ provider: 'claude' }, { provider: 'codex' }]);
    expect(result.copilotProfileId).toBeUndefined();
  });

  it('preserves a caller-supplied model and weight', () => {
    const panel: ConsensusProviderSpec[] = [
      { provider: 'claude', model: 'opus', weight: 2 },
    ];

    const result = applyConsensusCheckingPolicy(panel, '/no/copilot/scope');

    expect(result.panel).toEqual([{ provider: 'claude', model: 'opus', weight: 2 }]);
  });

  it('excludes no participant outside an enterprise scope', () => {
    const panel: ConsensusProviderSpec[] = [
      { provider: 'claude' },
      { provider: 'codex' },
      { provider: 'cursor' },
    ];

    expect(applyConsensusCheckingPolicy(panel, undefined).panel.map((spec) => spec.provider))
      .toEqual(['claude', 'codex', 'cursor']);
  });

  it('returns an empty panel unchanged', () => {
    expect(applyConsensusCheckingPolicy([], '/anywhere').panel).toEqual([]);
  });
});

describe('applyConsensusCheckingPolicy — enterprise scope', () => {
  it('keeps every participant when the panel is larger than the family count', async () => {
    // Regression: licence-pinned plans took one model per family, capping the
    // panel at 4. Consensus's own default fan-out is 5 providers, so the 5th
    // participant — and its weight — vanished silently.
    vi.resetModules();
    vi.doMock('../providers/copilot/copilot-account-routing-service', () => ({
      getCopilotAccountRoutingService: () => ({
        classifyWorkspaceScope: () => ({
          kind: 'protected',
          profileId: 'work',
          profileLabel: 'Work',
          accountKind: 'enterprise',
          automationPolicy: 'allow-routed',
        }),
      }),
    }));
    const { applyConsensusCheckingPolicy: pinned } = await import('./consensus-checking-policy');

    const panel: ConsensusProviderSpec[] = [
      { provider: 'claude', weight: 1 },
      { provider: 'codex', weight: 2 },
      { provider: 'antigravity', weight: 3 },
      { provider: 'copilot', weight: 4 },
      { provider: 'cursor', weight: 5 },
    ];

    const result = pinned(panel, '/work/ebrd/repo');

    expect(result.panel).toHaveLength(5);
    expect(result.panel.every((spec) => spec.provider === 'copilot')).toBe(true);
    expect(result.panel.map((spec) => spec.weight)).toEqual([1, 2, 3, 4, 5]);
    // Distinct models, so five participants are five real opinions.
    expect(new Set(result.panel.map((spec) => spec.model)).size).toBe(5);
    vi.doUnmock('../providers/copilot/copilot-account-routing-service');
  });
});
