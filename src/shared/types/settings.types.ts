/**
 * Settings Types - Application settings configuration
 *
 * Configuration hierarchy (highest to lowest priority):
 * 1. Project config (.ai-orchestrator.json in project root)
 * 2. User config (stored in app data)
 * 3. Default config (built-in defaults)
 */

import type { AuxiliaryLlmRoutingMode } from './auxiliary-llm.types';

export type ThemeMode = 'light' | 'dark' | 'system';
export type DisplayDensity = 'comfortable' | 'compact';
export type SidebarStyle = 'standard' | 'compact';
export type CanonicalCliType = 'claude' | 'gemini' | 'antigravity' | 'codex' | 'copilot' | 'auto' | 'cursor';
export type CliType = CanonicalCliType | 'openai'; // legacy alias kept for persisted settings compatibility
export type ConfigSource = 'project' | 'user' | 'default';
export type DefaultMissedRunPolicy = 'skip' | 'notify' | 'runOnce';
export type PauseReachabilityProbeMode = 'disabled' | 'reachable-means-vpn' | 'unreachable-means-vpn';
/**
 * How Harness handles newer versions of the CLI providers it wraps:
 * - `'off'`    — don't check; hide the update pill.
 * - `'notify'` — check + surface the pill/one-click update (t3code parity). Default.
 * - `'auto'`   — additionally apply *safe* updates automatically (npm/self-update
 *                only, never while a session is running). See cli-auto-update-service.
 */
export type CliUpdatePolicy = 'off' | 'notify' | 'auto';

/**
 * Application settings that are persisted to disk
 */
export interface AppSettings {
  // General
  defaultYoloMode: boolean;
  defaultWorkingDirectory: string;
  defaultCli: CliType;
  /**
   * Last-selected model when no per-provider memory exists. Kept for
   * backward compatibility with existing reads; the source of truth for
   * "what model should this provider start with" is `defaultModelByProvider`.
   * On changes, both fields are kept in sync for the currently-selected
   * provider so older code paths that still read `defaultModel` keep working.
   */
  defaultModel: string;
  /**
   * Last-selected model per CLI provider, so switching from
   * Claude → Copilot → Claude restores Claude's previous selection
   * instead of forcing the user to re-pick. Keys are `CanonicalCliType`
   * values minus 'auto' (auto has no concrete model). Missing entries
   * fall back to `getPrimaryModelForProvider(provider)`.
   */
  defaultModelByProvider: Record<string, string>;
  /**
   * Default "fast mode" preference for newly-spawned instances when no
   * per-provider entry exists. Fast mode trades some capability for faster
   * output: Claude sets the CLI `fastMode` settings key (Opus-only, needs a
   * paid subscription/credits); Codex requests the `priority` service tier
   * (~1.5x speed). Providers that don't support it ignore the flag.
   */
  defaultFastMode: boolean;
  /**
   * Last-selected fast-mode preference per CLI provider, so the toggle is
   * remembered across provider switches (mirrors `defaultModelByProvider`).
   * Keys are `CanonicalCliType` values minus 'auto'. Missing entries fall back
   * to `defaultFastMode`.
   */
  defaultFastModeByProvider: Record<string, boolean>;
  theme: ThemeMode;

  // Orchestration
  maxChildrenPerParent: number;
  maxTotalInstances: number; // 0 = unlimited
  autoTerminateIdleMinutes: number; // 0 = disabled
  allowNestedOrchestration: boolean;
  /**
   * Maximum hierarchy depth a spawned sub-agent may occupy (a child of a
   * top-level agent is depth 1). Caps deep delegation chains even when nested
   * orchestration is enabled, and is the recursion guard for the remote
   * `run_on_node` spawn path. 0 = unbounded. See claude2_todo #18.
   */
  maxSpawnDepth: number;
  defaultMissedRunPolicy: DefaultMissedRunPolicy;

  // Memory Management
  outputBufferSize: number; // messages kept in memory per instance
  enableDiskStorage: boolean; // save older output to disk
  maxDiskStorageMB: number; // max disk space for output storage (0 = unlimited)
  memoryWarningThresholdMB: number; // warn when heap exceeds this (0 = disabled)
  autoTerminateOnMemoryPressure: boolean; // terminate idle instances when memory critical
  persistSessionContent: boolean; // persist session content (conversation/tool output) to disk
  /**
   * Cost-cap compaction trigger (claude2_todo #34b): auto-compact an instance
   * once its cumulative token spend *since the last compaction* exceeds this
   * many tokens, independent of context-window fill %. Catches long sessions
   * (incl. self-managing CLIs that keep the window small while cost climbs).
   * 0 = disabled.
   */
  cumulativeTokenCompactionTrigger: number;
  /**
   * Output style (claude2_todo #29): appends a communication-style directive to
   * the system prompt of new root sessions ('default' = no change). Built-ins:
   * default | explanatory | learning | concise.
   */
  outputStyle: string;

  // Display
  fontSize: number; // 12-20
  displayDensity: DisplayDensity;
  sidebarStyle: SidebarStyle;
  contextWarningThreshold: number; // 0-100 percentage
  showToolMessages: boolean;
  showThinking: boolean; // Display AI thinking process in collapsible panels
  thinkingDefaultExpanded: boolean; // Show thinking panels expanded instead of collapsed
  showCost: boolean; // Display running cost estimates (per-instance and aggregated). Off = hide for managed setups.

  // Recent Directories
  maxRecentDirectories: number; // 5-500, max directories to remember

  // Advanced
  customModelOverride: string; // empty = use default
  parserBufferMaxKB: number; // max size for NDJSON parser buffer
  codememEnabled: boolean;
  codememIndexingEnabled: boolean;
  codememLspWorkerEnabled: boolean;
  /**
   * When true, codemem warms up workspace indexes automatically the moment a
   * workspace path enters the app (e.g. user picks a folder in the UI), rather
   * than waiting until the first CLI instance is spawned against it.
   */
  codememPrewarmEnabled: boolean;
  /**
   * Max simultaneous warm-up jobs. Prevents the index worker from being
   * saturated when several recent directories are opened in quick succession.
   */
  codememPrewarmMaxConcurrent: number;
  /**
   * Per-path debounce window for collapsing rapid-fire `directory-added`
   * events (e.g. user clicking around recent dirs) into a single warm call.
   */
  codememPrewarmDebounceMs: number;
  /**
   * When true, on app startup the most-recent local recent directory is
   * pre-warmed automatically so re-launching the same workspace is fast.
   */
  codememPrewarmStartupHint: boolean;
  commandDiagnosticsAvailable: boolean;
  broadRootFileThreshold: number;

  /**
   * Attach the `chrome-devtools` MCP server to an Harness-managed browser profile.
   * When enabled, spawned agents get a chrome-devtools server configured with
   * `--browserUrl` pointing at the managed profile's CDP endpoint, so they can
   * drive the same authenticated browser they opened via `browser.*`.
   */
  chromeDevtoolsAttachEnabled: boolean;
  /** Managed browser profile id chrome-devtools attaches to (empty = none). */
  chromeDevtoolsAttachProfileId: string;

  // Codebase auto-index (separate, heavier pipeline from codemem: BM25 +
  // vector embeddings + Merkle change detection + hybrid search). Auto-runs
  // incrementally whenever a workspace enters the app. See
  // docs/plans/2026-05-26-codebase-indexing-auto-start.md.
  /**
   * When true, the codebase indexing service auto-runs incremental indexes
   * whenever a workspace is opened (mirrors the codemem auto-warm trigger).
   */
  codebaseAutoIndexEnabled: boolean;
  /**
   * Hard cap on file count during preflight. Workspaces over this are
   * recorded as `'too_large'` and never auto-indexed — the user must use the
   * manual "Index" button which forces a full re-index.
   */
  codebaseAutoIndexMaxFiles: number;
  /**
   * Hard cap on total bytes during preflight. Same semantics as
   * `codebaseAutoIndexMaxFiles`.
   */
  codebaseAutoIndexMaxBytes: number;
  /**
   * Max simultaneous full-index runs. Defaults to 1 — this pipeline is much
   * heavier than codemem and we don't want two cold indexes hammering the
   * disk and embedder at once.
   */
  codebaseAutoIndexConcurrent: number;
  /**
   * Per-path debounce window for collapsing rapid-fire `directory-added`
   * events into a single index run.
   */
  codebaseAutoIndexDebounceMs: number;
  /**
   * When true, on app startup the most-recent local recent directory is
   * auto-indexed by the heavier codebase indexing pipeline. Defaults off so
   * app launch does not immediately compete with restored sessions.
   */
  codebaseAutoIndexStartupHint: boolean;

  // Project knowledge auto-mirror (RLM mirror of codemem snapshot + the
  // codebase miner — driven by `ProjectKnowledgeAutoMirrorCoordinator`).
  // See docs/plans/2026-05-26-project-code-index-bridge-auto-mirror.md.
  /**
   * When true, the RLM project-knowledge mirror (ProjectCodeIndexBridge +
   * CodebaseMiner via ProjectKnowledgeCoordinator) refreshes automatically
   * the moment a workspace path enters the app. Gated by codememEnabled +
   * codememIndexingEnabled — without those the bridge has nothing to mirror.
   */
  projectKnowledgeAutoMirrorEnabled: boolean;
  /**
   * Per-path debounce window for collapsing rapid-fire `directory-added`
   * events into a single mirror call.
   */
  projectKnowledgeAutoMirrorDebounceMs: number;
  /**
   * Max simultaneous mirror runs. The bridge serialises on the SQLite
   * writer; this cap mostly protects against five recent dirs being
   * opened in a row triggering five cold-codemem warm-ups in parallel.
   */
  projectKnowledgeAutoMirrorMaxConcurrent: number;
  /**
   * Skip re-running the auto-mirror if the bridge's `lastSyncedAt` is within
   * this window. Only applies to the auto-mirror coordinator — the spawn-time
   * call in `instance-lifecycle.ts` and the manual refresh IPC remain
   * un-throttled because they're the always-fresh safety net.
   */
  projectKnowledgeAutoMirrorSkipWithinMs: number;
  /**
   * When true, on app startup the most-recent local recent directory is
   * auto-mirrored so re-launching the same workspace surfaces the knowledge
   * graph immediately.
   */
  projectKnowledgeAutoMirrorStartupHint: boolean;

  // Cross-Model Review
  crossModelReviewEnabled: boolean;
  crossModelReviewDepth: 'structured' | 'tiered';
  crossModelReviewMaxReviewers: number;
  crossModelReviewProviders: string[];
  crossModelReviewTimeout: number;
  crossModelReviewTypes: string[];
  /**
   * Optional per-reviewer-CLI model override for cross-model review.
   * Keys are reviewer CLI names (e.g. 'copilot', 'gemini', 'codex', 'cursor').
   * A missing entry, an empty string, or 'auto' means "let that provider's CLI
   * decide" — we pass no model and the CLI uses its own default/auto routing
   * (e.g. Copilot auto-routes to a GPT model). A concrete model id is forwarded
   * to the reviewer adapter as its model. This does NOT fall back to
   * getPrimaryModelForProvider, so the default behaviour is true CLI routing.
   */
  crossModelReviewModelByProvider: Record<string, string>;

  // Conversational ping-pong review (bigchange_pingpong_review)
  /**
   * Default reviewer provider for ping-pong mode. `'auto'` resolves to any
   * installed provider that is NOT the builder's. A per-run override exists in
   * the loop control.
   */
  pingPongReviewerProvider: CanonicalCliType;
  /** Default hard cap on ping-pong rounds (clamped 1..20). */
  pingPongMaxRounds: number;

  // Remote Nodes
  remoteNodesEnabled: boolean;
  remoteNodesServerPort: number;
  remoteNodesServerHost: string;
  remoteNodesEnrollmentToken: string;
  remoteNodesAutoOffloadBrowser: boolean;
  remoteNodesAutoOffloadAndroid: boolean;
  remoteNodesAutoOffloadGpu: boolean;
  remoteNodesNamespace: string;
  remoteNodesRequireTls: boolean;
  remoteNodesTlsMode: 'auto' | 'custom';
  remoteNodesTlsCertPath: string;
  remoteNodesTlsKeyPath: string;
  remoteNodesRegisteredNodes: string;

  // Thin-client WebSocket API (web/mobile/event transport)
  thinClientWsEnabled: boolean;
  thinClientWsHost: string;
  thinClientWsPort: number;

  // Mobile Gateway (phone control app — see docs/mobile-app/)
  mobileGatewayEnabled: boolean;
  mobileGatewayPort: number;
  mobileGatewayBindInterface: 'tailscale' | 'all';
  /** JSON array of paired MobileDevice records. */
  mobileGatewayDevices: string;
  // Optional TLS (wss://). Tailscale already encrypts the link E2E, so this is
  // extra hardening only. Point these at a `tailscale cert <host>.<tailnet>.ts.net`
  // key/cert (publicly trusted, so iOS connects without a trust prompt). Empty =>
  // plain ws:// over the tailnet. Both must be set to enable TLS.
  mobileGatewayTlsCertPath: string;
  mobileGatewayTlsKeyPath: string;
  // APNs push (direct from Mac → Apple). Empty key => push disabled.
  /** PEM contents of the APNs Auth Key (.p8). */
  mobileGatewayApnsKeyP8: string;
  mobileGatewayApnsKeyId: string;
  mobileGatewayApnsTeamId: string;
  mobileGatewayApnsBundleId: string;
  /** true → api.push.apple.com, false → api.sandbox.push.apple.com. */
  mobileGatewayApnsProduction: boolean;

  // Network (Pause on VPN)
  pauseFeatureEnabled: boolean;
  pauseOnVpnEnabled: boolean;
  pauseVpnInterfacePattern: string;
  pauseTreatExistingVpnAsActive: boolean;
  pauseDetectorDiagnostics: boolean;
  pauseReachabilityProbeHost: string;
  pauseReachabilityProbeMode: PauseReachabilityProbeMode;
  pauseReachabilityProbeIntervalSec: number;
  pauseAllowPrivateRanges: boolean;

  // MCP Safety
  mcpCleanupBackupsOnQuit: boolean;
  mcpDisableProviderBackups: boolean;
  mcpAllowWorldWritableParent: boolean;

  // RTK (Rust Token Killer) — compresses LLM-bound shell command output 60–90%.
  // See bigchange_rtk_integration.md for details. On by default; users can opt out
  // via the RTK Savings settings tab.
  rtkEnabled: boolean;
  /** When true, never use a system-installed rtk; only the bundled binary. */
  rtkBundledOnly: boolean;

  // Notifications
  /** Show a desktop notification when an agent transitions from busy to idle. Default: true. */
  notifyOnAgentCompletion: boolean;

  // CLI Provider Updates
  /**
   * How to handle newer published versions of the wrapped CLI providers.
   * `'notify'` (default) matches t3code: detect + one-click. `'auto'` applies
   * safe updates unattended; `'off'` disables detection entirely.
   */
  cliUpdatePolicy: CliUpdatePolicy;

  /**
   * E14 — repo-map injection: when true, a compact ranked map of the project's
   * most important files and symbols is prepended to the system prompt of fresh
   * root sessions (depth 0, non-restore). Sourced from the codemem index when
   * available; falls back to a filesystem-walk heuristic when not indexed.
   * Default: true (the map is small — ~2 000 tokens — and provides structural
   * context that makes the first prompt dramatically more effective).
   */
  injectRepoMap: boolean;
  /**
   * Token budget for the injected repo map (E14). Larger budgets include more
   * files / symbols but consume more context. Default: 2 000 tokens.
   */
  repoMapTokenBudget: number;

  /**
   * A3 — Adapter-layer degraded-output detection.
   *
   * When true, the base CLI adapter classifies each completed response against
   * a set of degraded-output signals (stream idle timeout, zero-length content,
   * duplicate-of-prior, partial replay, cancelled) and tags `CliResponse` with
   * an optional `degradedReason`. Coordinators and supervisors can then use the
   * tag to trigger retries or raise alerts.
   *
   * DEFAULT: false — ships dormant until validated against a real degraded-stream
   * harness. Thresholds in `degraded-output-classifier.ts` need real data before
   * being trusted in production. When false, behavior is byte-identical to today:
   * no classification runs, no tag is added, zero overhead on the streaming path.
   */
  detectDegradedAdapterOutput: boolean;

  /**
   * D4 — offload local Claude/Gemini child-process stdio handling from the
   * Electron main thread to the CLI spawn worker. Default off while the pilot
   * path is validated in production.
   */
  enableSpawnWorkerOffload: boolean;

  // Auxiliary LLM (local/cheap model routing for helper calls)
  auxiliaryLlmEnabled: boolean;
  auxiliaryLlmRoutingMode: AuxiliaryLlmRoutingMode;
  auxiliaryLlmAllowRemoteWorkerModels: boolean;
  /**
   * Whether to use this (coordinator) machine's own localhost Ollama for
   * auxiliary routing. Turn off to keep offload on remote worker nodes (e.g. a
   * dedicated GPU box) without stopping the local Ollama, which other features
   * such as embeddings still use.
   */
  auxiliaryLlmUseLocalhostOllama: boolean;
  auxiliaryLlmEndpointsJson: string;
  auxiliaryLlmSlotsJson: string;
  /**
   * Model ids used by the per-slot quality tiers. Slots tagged `tier: 'quick'`
   * resolve to `auxiliaryLlmQuickModel` (small/fast — scoring, routing, titles)
   * and `tier: 'quality'` to `auxiliaryLlmQualityModel` (larger — compression,
   * distillation), unless a slot pins an explicit model. Empty = auto-pick.
   */
  auxiliaryLlmQuickModel: string;
  auxiliaryLlmQualityModel: string;
  /**
   * Let the auxiliary `routingClassification` slot influence Loop Mode
   * model selection. When on, each routed loop spawn asks the aux model whether
   * the task is cheap-model eligible and, if so, prefers the fast tier — at the
   * cost of one extra aux call per spawn. Default on so simple loop work can
   * downshift away from the balanced tier without a Claude call.
   */
  auxiliaryLlmRoutingClassificationEnabled: boolean;

  // Reactions (event-driven re-prompting)
  /**
   * Global master switch for the Reaction Engine (event-driven re-prompting).
   * When true (default), the engine is willing to react, but `send-to-agent`
   * reactions still require per-instance arming (default off per instance), so
   * default-on never surprise-prompts an un-armed instance. When false, no
   * reactions fire anywhere regardless of per-instance arming (kill switch).
   */
  reactionsEnabled: boolean;
  /**
   * How often (ms) the reaction engine polls tracked PR/CI state.
   * Only relevant when reactionsEnabled is true. Default: 60 000 (1 min).
   */
  reactionsPollIntervalMs: number;
}

/**
 * Default settings values
 */
export const DEFAULT_SETTINGS: AppSettings = {
  // General
  defaultYoloMode: false,
  defaultWorkingDirectory: '',
  defaultCli: 'auto',
  defaultModel: 'opus[1m]',
  defaultModelByProvider: {},
  defaultFastMode: false,
  defaultFastModeByProvider: {},
  theme: 'dark',

  // Orchestration
  maxChildrenPerParent: 10,
  maxTotalInstances: 20,
  autoTerminateIdleMinutes: 30,
  allowNestedOrchestration: false,
  maxSpawnDepth: 3,
  defaultMissedRunPolicy: 'notify',

  // Memory Management
  outputBufferSize: 500, // keep 500 messages in memory per instance
  enableDiskStorage: true, // save older output to disk
  maxDiskStorageMB: 500, // 500MB max disk storage
  memoryWarningThresholdMB: 1024, // warn at 1GB heap
  autoTerminateOnMemoryPressure: true,
  persistSessionContent: true,
  cumulativeTokenCompactionTrigger: 0, // disabled by default (opt-in cost cap)
  outputStyle: 'default', // no style directive injected unless changed

  // Display
  fontSize: 14,
  displayDensity: 'comfortable',
  sidebarStyle: 'standard',
  contextWarningThreshold: 80,
  showToolMessages: true,
  showThinking: true,
  thinkingDefaultExpanded: false,
  showCost: true,

  // Recent Directories
  maxRecentDirectories: 200,

  // Advanced
  customModelOverride: '',
  parserBufferMaxKB: 1024, // 1MB max parser buffer
  codememEnabled: true,
  codememIndexingEnabled: true,
  codememLspWorkerEnabled: true,
  codememPrewarmEnabled: true,
  codememPrewarmMaxConcurrent: 2,
  codememPrewarmDebounceMs: 1500,
  codememPrewarmStartupHint: true,
  commandDiagnosticsAvailable: true,
  broadRootFileThreshold: 100,
  chromeDevtoolsAttachEnabled: false,
  chromeDevtoolsAttachProfileId: '',

  // Codebase auto-index defaults
  codebaseAutoIndexEnabled: false,
  codebaseAutoIndexMaxFiles: 3_000,
  codebaseAutoIndexMaxBytes: 150 * 1024 * 1024,
  codebaseAutoIndexConcurrent: 1,
  codebaseAutoIndexDebounceMs: 15_000,
  codebaseAutoIndexStartupHint: false,

  // Project knowledge auto-mirror defaults
  projectKnowledgeAutoMirrorEnabled: true,
  projectKnowledgeAutoMirrorDebounceMs: 2_000,
  projectKnowledgeAutoMirrorMaxConcurrent: 1,
  projectKnowledgeAutoMirrorSkipWithinMs: 30_000,
  projectKnowledgeAutoMirrorStartupHint: false,

  // Cross-Model Review
  crossModelReviewEnabled: true,
  crossModelReviewDepth: 'structured',
  crossModelReviewMaxReviewers: 2,
  crossModelReviewProviders: ['cursor', 'antigravity', 'codex'],
  crossModelReviewTimeout: 30,
  crossModelReviewTypes: ['code', 'plan', 'architecture'],
  crossModelReviewModelByProvider: { cursor: 'composer-2.5' },

  // Conversational ping-pong review
  pingPongReviewerProvider: 'auto',
  pingPongMaxRounds: 15,

  // Remote Nodes
  remoteNodesEnabled: false,
  remoteNodesServerPort: 4878,
  remoteNodesServerHost: '0.0.0.0',
  remoteNodesEnrollmentToken: '',
  remoteNodesAutoOffloadBrowser: true,
  remoteNodesAutoOffloadAndroid: true,
  remoteNodesAutoOffloadGpu: false,
  remoteNodesNamespace: 'default',
  remoteNodesRequireTls: false,
  remoteNodesTlsMode: 'auto' as const,
  remoteNodesTlsCertPath: '',
  remoteNodesTlsKeyPath: '',
  remoteNodesRegisteredNodes: '{}',

  // Thin-client WebSocket API
  thinClientWsEnabled: true,
  thinClientWsHost: '127.0.0.1',
  thinClientWsPort: 4880,

  // Mobile Gateway (phone control app)
  mobileGatewayEnabled: false,
  mobileGatewayPort: 4879,
  mobileGatewayBindInterface: 'tailscale' as const,
  mobileGatewayDevices: '[]',
  mobileGatewayTlsCertPath: '',
  mobileGatewayTlsKeyPath: '',
  mobileGatewayApnsKeyP8: '',
  mobileGatewayApnsKeyId: '',
  mobileGatewayApnsTeamId: '',
  mobileGatewayApnsBundleId: 'com.shutupandshave.aiorchestrator',
  mobileGatewayApnsProduction: false,

  // Network (Pause on VPN)
  pauseFeatureEnabled: true,
  pauseOnVpnEnabled: true,
  pauseVpnInterfacePattern: '^(utun[0-9]+|ipsec[0-9]+|ppp[0-9]+|tap[0-9]+)$',
  pauseTreatExistingVpnAsActive: true,
  pauseDetectorDiagnostics: false,
  pauseReachabilityProbeHost: '',
  pauseReachabilityProbeMode: 'disabled',
  pauseReachabilityProbeIntervalSec: 30,
  pauseAllowPrivateRanges: false,

  // MCP Safety
  mcpCleanupBackupsOnQuit: true,
  mcpDisableProviderBackups: false,
  mcpAllowWorldWritableParent: false,

  // RTK
  rtkEnabled: true,
  rtkBundledOnly: false,

  // Notifications
  notifyOnAgentCompletion: true,

  // CLI Provider Updates
  cliUpdatePolicy: 'notify',

  // E14 — repo-map injection
  injectRepoMap: true,
  repoMapTokenBudget: 2_000,

  // A3 — adapter-layer degraded-output detection (off by default)
  detectDegradedAdapterOutput: false,

  // D4 — CLI spawn worker offload pilot (off by default)
  enableSpawnWorkerOffload: false,

  // Reactions
  reactionsEnabled: true,
  reactionsPollIntervalMs: 60_000,

  // Auxiliary LLM
  auxiliaryLlmEnabled: true,
  auxiliaryLlmRoutingMode: 'local-first',
  auxiliaryLlmAllowRemoteWorkerModels: true,
  auxiliaryLlmUseLocalhostOllama: true,
  auxiliaryLlmEndpointsJson: '[]',
  auxiliaryLlmQuickModel: '',
  auxiliaryLlmQualityModel: '',
  auxiliaryLlmRoutingClassificationEnabled: true,
  auxiliaryLlmSlotsJson: JSON.stringify({
    compression: { enabled: true, provider: 'auto', tier: 'quality', maxInputTokens: 96000, maxOutputTokens: 4096, temperature: 0.2, timeoutMs: 60000, requireJson: false, allowFrontierFallback: true },
    memoryDistillation: { enabled: true, provider: 'auto', tier: 'quality', maxInputTokens: 64000, maxOutputTokens: 2048, temperature: 0.2, timeoutMs: 45000, requireJson: false, allowFrontierFallback: true },
    webExtract: { enabled: true, provider: 'auto', tier: 'quality', maxInputTokens: 64000, maxOutputTokens: 2048, temperature: 0.1, timeoutMs: 30000, requireJson: false, allowFrontierFallback: false },
    titleGeneration: { enabled: true, provider: 'auto', tier: 'quick', maxInputTokens: 12000, maxOutputTokens: 512, temperature: 0.2, timeoutMs: 45000, requireJson: false, allowFrontierFallback: false },
    routingClassification: { enabled: true, provider: 'auto', tier: 'quick', maxInputTokens: 16000, maxOutputTokens: 512, temperature: 0, timeoutMs: 45000, requireJson: true, allowFrontierFallback: false },
    approvalScoring: { enabled: true, provider: 'auto', tier: 'quick', maxInputTokens: 16000, maxOutputTokens: 512, temperature: 0, timeoutMs: 45000, requireJson: true, allowFrontierFallback: false },
    loopScoring: { enabled: true, provider: 'auto', tier: 'quick', maxInputTokens: 32000, maxOutputTokens: 1024, temperature: 0, timeoutMs: 30000, requireJson: true, allowFrontierFallback: false },
    retrievalHypothesis: { enabled: true, provider: 'auto', tier: 'quick', maxInputTokens: 4096, maxOutputTokens: 300, temperature: 0.3, timeoutMs: 2500, requireJson: false, allowFrontierFallback: false },
    branchScoring: { enabled: true, provider: 'auto', tier: 'quick', maxInputTokens: 16000, maxOutputTokens: 512, temperature: 0, timeoutMs: 30000, requireJson: true, allowFrontierFallback: true },
    subQueryExecution: { enabled: false, provider: 'auto', tier: 'quality', maxInputTokens: 64000, maxOutputTokens: 2048, temperature: 0.2, timeoutMs: 45000, requireJson: false, allowFrontierFallback: true },
  }),
};

export { SETTINGS_METADATA } from './settings-metadata';
export type { SettingMetadata } from './settings-metadata';

// ============================================
// Project Configuration Types
// ============================================

/**
 * Project-level configuration file format
 * Stored in .ai-orchestrator.json in project root
 */
export interface ProjectConfig {
  // Project identity
  name?: string;
  description?: string;

  // Override settings (partial)
  settings?: Partial<AppSettings>;

  // Agent configuration
  defaultAgent?: string; // Default agent mode for this project

  // Custom commands for this project
  commands?: {
    name: string;
    description: string;
    template: string;
    hint?: string;
  }[];

  // File patterns to ignore
  ignorePatterns?: string[];

  // Custom system prompt additions
  systemPromptAdditions?: string;
}

/**
 * Resolved configuration with source tracking
 */
export interface ResolvedConfig {
  settings: AppSettings;
  sources: Record<keyof AppSettings, ConfigSource>;
  projectConfig?: ProjectConfig;
  projectPath?: string;
}

/**
 * Project config file name
 */
export const PROJECT_CONFIG_FILE = '.ai-orchestrator.json';

/**
 * Legacy project config file name (for backward compatibility)
 */
export const LEGACY_PROJECT_CONFIG_FILE = '.claude-orchestrator.json';

/**
 * Merge project config with user settings
 */
export function mergeConfigs(
  defaultSettings: AppSettings,
  userSettings: Partial<AppSettings>,
  projectSettings?: Partial<AppSettings>
): ResolvedConfig {
  const settings = { ...defaultSettings };
  const sources: Record<string, ConfigSource> = {};
  const applySetting = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
    source: ConfigSource
  ) => {
    settings[key] = value;
    sources[key] = source;
  };

  // Start with defaults
  for (const key of Object.keys(defaultSettings) as (keyof AppSettings)[]) {
    sources[key] = 'default';
  }

  // Apply user settings
  if (userSettings) {
    for (const [key, value] of Object.entries(userSettings)) {
      if (value !== undefined) {
        const typedKey = key as keyof AppSettings;
        applySetting(typedKey, value as AppSettings[typeof typedKey], 'user');
      }
    }
  }

  // Apply project settings (highest priority)
  if (projectSettings) {
    for (const [key, value] of Object.entries(projectSettings)) {
      if (value !== undefined) {
        const typedKey = key as keyof AppSettings;
        applySetting(typedKey, value as AppSettings[typeof typedKey], 'project');
      }
    }
  }

  return {
    settings,
    sources: sources as Record<keyof AppSettings, ConfigSource>
  };
}
