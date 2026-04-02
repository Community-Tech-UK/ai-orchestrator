import { describe, it, expect, afterEach } from 'vitest';
import { ORCHESTRATION_FEATURES, isFeatureEnabled, type FeatureFlag } from './feature-flags';

describe('Feature Flags', () => {
  afterEach(() => {
    // Clean up any env overrides
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ORCH_FEATURE_')) {
        delete process.env[key];
      }
    }
  });

  it('has all required feature flags', () => {
    expect(ORCHESTRATION_FEATURES.DEBATE_SYSTEM).toBeDefined();
    expect(ORCHESTRATION_FEATURES.VERIFICATION_SYSTEM).toBeDefined();
    expect(ORCHESTRATION_FEATURES.CONSENSUS_SYSTEM).toBeDefined();
    expect(ORCHESTRATION_FEATURES.PARALLEL_WORKTREE).toBeDefined();
  });

  it('has new infrastructure flags', () => {
    expect(ORCHESTRATION_FEATURES.STREAMING_TOOLS).toBeDefined();
    expect(ORCHESTRATION_FEATURES.LAYERED_COMPACTION).toBeDefined();
    expect(ORCHESTRATION_FEATURES.ERROR_WITHHOLDING).toBeDefined();
    expect(ORCHESTRATION_FEATURES.TOKEN_BUDGET).toBeDefined();
    expect(ORCHESTRATION_FEATURES.FILE_WATCHER_CACHE).toBeDefined();
  });

  it('isFeatureEnabled returns boolean', () => {
    const result = isFeatureEnabled('DEBATE_SYSTEM');
    expect(typeof result).toBe('boolean');
  });

  it('isFeatureEnabled respects environment overrides', () => {
    process.env['ORCH_FEATURE_DEBATE_SYSTEM'] = 'false';
    expect(isFeatureEnabled('DEBATE_SYSTEM')).toBe(false);
    delete process.env['ORCH_FEATURE_DEBATE_SYSTEM'];
  });
});
