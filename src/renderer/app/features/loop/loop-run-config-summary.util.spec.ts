import { describe, expect, it } from 'vitest';
import { buildRunConfigSummary, iterationCapLabel } from './loop-run-config-summary.util';

describe('buildRunConfigSummary', () => {
  it('shows the spawn model beside the provider when the last iteration recorded one', () => {
    const rows = buildRunConfigSummary({
      manualReviewOnly: false,
      lastIteration: { model: 'claude-sonnet-4-6' },
      config: {
        provider: 'claude',
        contextStrategy: 'same-session',
        initialStage: 'IMPLEMENT',
        caps: {
          maxIterations: 50,
          maxWallTimeMs: 3_600_000,
          maxTokens: null,
          maxCostCents: null,
        },
        completion: { verifyCommand: 'npm test' },
      },
    });
    expect(rows.find((row) => row.label === 'Provider')?.value).toBe('claude · claude-sonnet-4-6');
    expect(rows.find((row) => row.label === 'Caps')?.value).toContain('no token cap');
    expect(iterationCapLabel(null)).toBe('∞');
  });
});
