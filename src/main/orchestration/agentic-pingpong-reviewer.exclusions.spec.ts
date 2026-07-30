import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ping-pong reviewer is the sharpest edge of the automation-exclusion
 * setting. Its Tier 2 resolution deliberately WIDENS to any installed
 * non-builder provider when the preferred codex/claude pair is exhausted, so a
 * provider excluded everywhere else could still be pulled into a review here.
 */

const runReviewSession = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  excluded: [] as string[],
  availableClis: [] as { name: string; installed: boolean }[],
}));

vi.mock('./reviewer-session-spawner', () => ({
  getReviewerSessionSpawner: () => ({ runReviewSession }),
}));
vi.mock('../cli/cli-detection', () => ({
  detectAvailableClis: vi.fn(async () => state.availableClis),
}));
vi.mock('../review/review-execution-host', () => ({
  resolveReviewerModelOverride: vi.fn(() => undefined),
}));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ providersExcludedFromAutomation: state.excluded }),
  }),
}));

import { agenticPingPongReviewer } from './agentic-pingpong-reviewer';
import { _resetAutomationProviderExclusionsForTesting } from '../providers/automation-provider-exclusions';

function mockApprovedReviewSession(): void {
  runReviewSession.mockResolvedValueOnce({
    outcome: 'settled',
    finalOutput:
      '```json\n' +
      JSON.stringify({
        verdict: 'APPROVED',
        summary: 'No blocking issues remain.',
        completeness: { filesInspected: 1, commandsRun: 0, scopeCovered: 'src/widget.ts' },
        findings: [],
        ledger: [],
      }) +
      '\n```',
    instanceId: 'rev-1',
    tokensUsed: 123,
    costCents: 4,
  });
}

function review(overrides: Record<string, unknown> = {}) {
  return agenticPingPongReviewer({
    loopRunId: 'loop-1',
    workspaceCwd: '/repo',
    goal: 'finish the widget',
    subject: 'impl',
    builderProvider: 'claude',
    reviewerProviderSetting: 'auto',
    triedReviewerProviders: [],
    ledger: [],
    roundNumber: 1,
    maxRounds: 15,
    blockingSeverities: ['critical', 'high'],
    timeoutMs: 90_000,
    ...overrides,
  } as Parameters<typeof agenticPingPongReviewer>[0]);
}

describe('ping-pong reviewer — automation provider exclusions', () => {
  beforeEach(() => {
    state.excluded = [];
    state.availableClis = [
      { name: 'claude', installed: true },
      { name: 'copilot', installed: true },
    ];
    _resetAutomationProviderExclusionsForTesting();
    runReviewSession.mockReset();
  });

  describe('Tier 2 widening', () => {
    it('widens to copilot when the pair is exhausted and nothing is excluded', async () => {
      // Baseline: proves the widening path really does reach copilot, so the
      // exclusion test below is not passing for an unrelated reason.
      mockApprovedReviewSession();

      const result = await review();

      expect(result.reviewerProvider).toBe('copilot');
    });

    it('does not widen to an excluded provider', async () => {
      state.excluded = ['copilot'];

      const result = await review();

      expect(result.reviewerProvider).not.toBe('copilot');
      expect(runReviewSession).not.toHaveBeenCalled();
    });

    it('widens to a different installed provider instead of the excluded one', async () => {
      state.excluded = ['copilot'];
      state.availableClis = [
        { name: 'claude', installed: true },
        { name: 'copilot', installed: true },
        { name: 'cursor', installed: true },
      ];
      mockApprovedReviewSession();

      const result = await review();

      expect(result.reviewerProvider).toBe('cursor');
    });
  });

  describe('Tier 1 preference', () => {
    it('still prefers codex over a widened provider', async () => {
      state.excluded = ['copilot'];
      state.availableClis = [
        { name: 'claude', installed: true },
        { name: 'codex', installed: true },
        { name: 'copilot', installed: true },
      ];
      mockApprovedReviewSession();

      const result = await review();

      expect(result.reviewerProvider).toBe('codex');
    });
  });

  describe('explicitly configured reviewer', () => {
    it('refuses an excluded provider named by pingPongReviewerProvider', async () => {
      // Two settings contradict each other; the exclusion wins and the
      // resolution falls through to auto rather than honouring the reviewer.
      state.excluded = ['copilot'];
      state.availableClis = [
        { name: 'claude', installed: true },
        { name: 'codex', installed: true },
        { name: 'copilot', installed: true },
      ];
      mockApprovedReviewSession();

      const result = await review({ reviewerProviderSetting: 'copilot' });

      expect(result.reviewerProvider).toBe('codex');
    });

    it('honours a configured reviewer that is not excluded', async () => {
      state.excluded = ['copilot'];
      state.availableClis = [
        { name: 'claude', installed: true },
        { name: 'codex', installed: true },
        { name: 'cursor', installed: true },
      ];
      mockApprovedReviewSession();

      const result = await review({ reviewerProviderSetting: 'cursor' });

      expect(result.reviewerProvider).toBe('cursor');
    });
  });

  it('stays excluded when provider detection fails and the pool is empty', async () => {
    // With detection unavailable the `installed` gate degrades to "any provider
    // is allowed", so only the direct exclusion check stands between the
    // configured reviewer and a real review call. It has to hold on its own.
    state.excluded = ['copilot'];
    state.availableClis = [];
    mockApprovedReviewSession();

    const result = await review({ reviewerProviderSetting: 'copilot' });

    expect(result.reviewerProvider).toBe('codex');
  });
});
