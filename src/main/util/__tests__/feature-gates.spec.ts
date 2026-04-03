import { describe, it, expect, afterEach } from 'vitest';

// No electron mock needed — feature-gates.ts is a pure utility.

describe('feature()', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('returns true for a known-enabled flag', async () => {
    const { feature } = await import('../feature-gates');
    // DEBATE_SYSTEM defaults to true in ORCHESTRATION_FEATURES
    expect(feature('DEBATE_SYSTEM')).toBe(true);
  });

  it('respects ORCH_FEATURE_<FLAG>=false env override', async () => {
    process.env['ORCH_FEATURE_DEBATE_SYSTEM'] = 'false';
    // Re-import to pick up env change (or use direct call — feature() reads env at call time)
    const { feature } = await import('../feature-gates');
    expect(feature('DEBATE_SYSTEM')).toBe(false);
  });

  it('respects ORCH_FEATURE_<FLAG>=true env override for a default-false flag', async () => {
    // Add a test flag temporarily via env — use a known flag that could be toggled
    process.env['ORCH_FEATURE_TOKEN_BUDGET'] = 'true';
    const { feature } = await import('../feature-gates');
    expect(feature('TOKEN_BUDGET')).toBe(true);
  });

  it('returns false for an unknown flag string', async () => {
    const { feature } = await import('../feature-gates');
    expect(feature('NONEXISTENT_FLAG_XYZ')).toBe(false);
  });

  it('returns true when __FEATURES__ build-time object contains the flag', async () => {
    // Simulate the build-time path by calling featureFromRecord directly
    const { featureFromRecord } = await import('../feature-gates');
    expect(featureFromRecord({ MY_FEATURE: true }, 'MY_FEATURE')).toBe(true);
    expect(featureFromRecord({ MY_FEATURE: false }, 'MY_FEATURE')).toBe(false);
    expect(featureFromRecord({}, 'MY_FEATURE')).toBe(false);
  });

  it('feature() is callable with any string — no TypeScript error at call site', async () => {
    const { feature } = await import('../feature-gates');
    // Should not throw — unknown flags just return false
    expect(() => feature('ANYTHING')).not.toThrow();
  });
});
