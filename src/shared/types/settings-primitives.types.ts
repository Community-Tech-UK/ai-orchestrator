/**
 * Primitive/enum type aliases used as `AppSettings` field types.
 *
 * Extracted from `settings.types.ts` (LOC ratchet split): self-contained —
 * no dependency on `AppSettings` itself — so it can live in its own module
 * while `settings.types.ts` re-exports it for existing importers.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type DisplayDensity = 'comfortable' | 'compact';

/**
 * The orchestration gates whose model tier an operator can pin.
 *
 * These are finer-grained than `RoutingIntent` (`loop | workflow | scaffolding |
 * synthesis`) on purpose: verify, review and non-synthesis debate all share the
 * `scaffolding` intent, but they are very different jobs with very different
 * cost/quality trade-offs, and an operator needs to tune them independently.
 */
export type OrchestrationRoutingPolicyKey =
  | 'loop'
  | 'workflow'
  | 'verify'
  | 'review'
  | 'debate'
  | 'debateSynthesis';

/** A pinned tier, or `auto` to defer to the router's keyword heuristic. */
export type OrchestrationRoutingPolicyValue = 'auto' | 'fast' | 'balanced' | 'powerful';

export type SidebarStyle = 'standard' | 'compact';
export type CanonicalCliType = 'claude' | 'gemini' | 'antigravity' | 'codex' | 'copilot' | 'auto' | 'cursor' | 'grok';
export type CliType = CanonicalCliType | 'openai'; // legacy alias kept for persisted settings compatibility
export type ConfigSource = 'project' | 'user' | 'default';
export type DefaultMissedRunPolicy = 'skip' | 'notify' | 'runOnce';
export type PauseReachabilityProbeMode = 'disabled' | 'reachable-means-vpn' | 'unreachable-means-vpn';
export type VoiceSttRoutingMode = 'auto' | 'this-device' | 'worker-node' | 'cloud' | 'this-device-or-cloud';
export type ProjectPluginTrust = 'trusted' | 'untrusted' | 'ask';
/** CLI update policy: off | notify (default) | auto (safe updates only). */
export type CliUpdatePolicy = 'off' | 'notify' | 'auto';
export type ContextEvidenceMode = 'off' | 'shadow' | 'enforce';
