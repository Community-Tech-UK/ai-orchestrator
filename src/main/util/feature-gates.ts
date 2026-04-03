/**
 * Feature gates — thin wrapper around isFeatureEnabled() that additionally
 * supports a build-time __FEATURES__ global for dead-code elimination via esbuild.
 *
 * Build-time usage (esbuild define):
 *   define: { '__FEATURES__': JSON.stringify({ DEBATE_SYSTEM: true, ... }) }
 *
 * When __FEATURES__ is defined at bundle time, esbuild can eliminate the
 * dead branch and tree-shake disabled feature code entirely.
 *
 * Runtime fallback: delegates to isFeatureEnabled() from feature-flags.ts,
 * which supports ORCH_FEATURE_<FLAG>=true|false environment overrides.
 */
import { isFeatureEnabled, type FeatureFlag } from '../../shared/constants/feature-flags';

declare const __FEATURES__: Record<string, boolean> | undefined;

/**
 * Exported for testing: check a flag against an explicit record.
 * This is the code path taken when __FEATURES__ is defined at build time.
 */
export function featureFromRecord(record: Record<string, boolean>, flag: string): boolean {
  return record[flag] === true;
}

/**
 * Check whether a feature flag is enabled.
 *
 * At build time, if esbuild replaces __FEATURES__ with a literal object,
 * the dead branch is eliminated. At runtime, falls back to isFeatureEnabled()
 * which reads ORCH_FEATURE_<FLAG> environment variables.
 */
export function feature(flag: string): boolean {
  // Build-time path: esbuild replaces __FEATURES__ with a literal object,
  // allowing the minifier to eliminate dead branches.
  try {
    if (typeof __FEATURES__ !== 'undefined') {
      return featureFromRecord(__FEATURES__, flag);
    }
  } catch {
    // __FEATURES__ is not defined at build time — fall through to runtime path.
  }
  // Runtime fallback: use the env-override-aware runtime function.
  // Cast to FeatureFlag — unknown flags return undefined/false from isFeatureEnabled.
  return isFeatureEnabled(flag as FeatureFlag) === true;
}
