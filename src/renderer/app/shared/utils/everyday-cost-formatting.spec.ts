import { describe, expect, it } from 'vitest';
import { StatsPageComponent } from '../../features/stats/stats-page.component';
import { VerificationResultsComponent } from '../../features/verification/results/verification-results.component';
import { VerificationMonitorComponent } from '../../features/verification/execution/verification-monitor.component';
import { CostEstimatorComponent } from '../components/cost-estimator/cost-estimator.component';

describe('everyday cost displays', () => {
  it.each([
    ['statistics', StatsPageComponent.prototype.formatCost],
    ['verification results', VerificationResultsComponent.prototype.formatCost],
    ['verification progress', VerificationMonitorComponent.prototype.formatCost],
    ['cost estimate', CostEstimatorComponent.prototype.formatCost],
  ] as const)('uses cents and discloses tiny nonzero costs in %s', (_name, format) => {
    expect(format(0.7302072)).toBe('$0.73');
    expect(format(0.001)).toBe('under 1 cent');
    expect(format(0.009)).toBe('$0.01');
    expect(format(12.4)).toBe('$12.40');
  });

  it('preserves the unavailable and free states', () => {
    expect(StatsPageComponent.prototype.formatCost(undefined)).toBe('—');
    expect(VerificationResultsComponent.prototype.formatCost(undefined)).toBe('Unknown');
    expect(VerificationResultsComponent.prototype.formatCost('unknown')).toBe('Unknown');
    expect(VerificationMonitorComponent.prototype.formatCost('unknown')).toBe('Unknown');
    expect(CostEstimatorComponent.prototype.formatCost(0)).toBe('Free');
  });
});
