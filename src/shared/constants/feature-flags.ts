/**
 * Feature flags for optional orchestration systems.
 *
 * Enhanced with:
 * - Environment variable overrides (ORCH_FEATURE_<FLAG>=true/false)
 * - Runtime-checkable helper function
 * - New flags for infrastructure improvements
 *
 * Inspired by Claude Code's bundle-time feature() system.
 * In our Electron build, these are runtime-checked but the pattern
 * supports tree-shaking in future Vite/esbuild compilation.
 */

export const ORCHESTRATION_FEATURES = {
  // Existing coordination systems
  DEBATE_SYSTEM: true,
  VERIFICATION_SYSTEM: true,
  CONSENSUS_SYSTEM: true,
  PARALLEL_WORKTREE: true,

  // New infrastructure features
  STREAMING_TOOLS: true,
  LAYERED_COMPACTION: true,
  ERROR_WITHHOLDING: true,
  TOKEN_BUDGET: true,
  FILE_WATCHER_CACHE: true,
  LIFECYCLE_HOOKS: true,

  // Audit / observability
  EVENT_SOURCING: false,
} as const;

export type FeatureFlag = keyof typeof ORCHESTRATION_FEATURES;

/**
 * Check if a feature flag is enabled, with environment variable override.
 * Environment: ORCH_FEATURE_<FLAG_NAME>=true|false
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  const envKey = `ORCH_FEATURE_${flag}`;
  const envValue = process.env[envKey];

  if (envValue !== undefined) {
    return envValue.toLowerCase() !== 'false' && envValue !== '0';
  }

  return ORCHESTRATION_FEATURES[flag];
}
