/** Application settings shared by the main and renderer processes. */

import type { AuxiliaryLlmRoutingMode } from './auxiliary-llm.types';
import type { DesktopComputerUseSettings } from './desktop-gateway-settings.types';
import type { ModelUsageEntry } from './model-usage.types';
import type { WorkerModeSettings } from './pair-both.types';
import type { RemoteReviewerProvider } from './reviewer-provider.types';

export type { ModelUsageEntry } from './model-usage.types';

// Default values live in settings-defaults.ts; re-exported here so importers
// keep a single module for both the shape and the shipped defaults.
export {
  DEFAULT_LOOP_MODEL_BY_PROVIDER,
  DEFAULT_CONTEXT_EVIDENCE_MODE_BY_PROVIDER,
  DEFAULT_ORCHESTRATION_ROUTING_POLICY,
  DEFAULT_ORCHESTRATION_ROUTING_POLICY_JSON,
  DEFAULT_REVIEWER_MODEL_BY_PROVIDER,
  DEFAULT_SETTINGS,
} from './settings-defaults';

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

/** Application settings that are persisted to disk. */
export interface AppSettings extends DesktopComputerUseSettings {
  // General
  defaultYoloMode: boolean;
  defaultWorkingDirectory: string;
  defaultCli: CliType;
  /**
   * Legacy last-selected model. Source of truth is `defaultModelByProvider`;
   * kept in sync for older readers.
   */
  defaultModel: string;
  /**
   * Last-selected model per CLI provider (keys: CanonicalCliType minus 'auto').
   * Missing entries fall back to `getPrimaryModelForProvider(provider)`.
   */
  defaultModelByProvider: Record<string, string>;
  /**
   * Dedicated provider for automation runs whose Model is left on **Auto**.
   * Unlike `defaultCli`/`defaultModelByProvider`, this is NEVER rewritten by
   * interactive picker usage, so Auto automations stay on a stable model
   * instead of inheriting whatever the last chat happened to select.
   * `'auto'` means "no automation-specific override — fall through to the
   * normal provider resolution".
   */
  automationDefaultCli: CliType;
  /**
   * Dedicated model id for automation runs whose Model is left on **Auto**.
   * Empty string means "no override — fall through to the provider default".
   * Paired with `automationDefaultCli`.
   */
  automationDefaultModel: string;
  /**
   * Global fast-mode default when no per-provider entry exists. Claude uses
   * CLI `fastMode`; Codex uses priority tier; others ignore.
   */
  defaultFastMode: boolean;
  /** Per-provider fast-mode memory; falls back to `defaultFastMode`. */
  defaultFastModeByProvider: Record<string, boolean>;
  /** Hybrid picker usage memory (`provider:modelId` → count/lastUsedAt). */
  modelUsageByKey: Record<string, ModelUsageEntry>;
  /**
   * Resident Claude interrupt via stdin `control_request` instead of SIGINT.
   * Default true so steering aborts the turn without respawning.
   */
  residentClaudeSession: boolean;
  /** Per-concrete-provider rollout mode for durable context evidence. */
  contextEvidenceModeByProvider: Record<string, ContextEvidenceMode>;
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
  /** Operator-only: revive a terminal chat to deliver a submitted doc review. */
  docReviewResumeOnSubmit: boolean;
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
  /**
   * User-entered model ids per provider. These feed the unified model catalog as
   * `user-custom` entries so newly shipped models can be selected without an app
   * rebuild while still preserving the legacy single-model override below.
   */
  customModelsByProvider: Record<string, string[]>;
  /**
   * Optional HTTP(S) JSON catalog override URL. Empty disables the remote
   * source; non-empty URLs are still checked by the main-process network policy
   * before any request is made.
   */
  modelCatalogRemoteOverrideUrl: string;
  parserBufferMaxKB: number; // max size for NDJSON parser buffer
  codememEnabled: boolean;
  /** Fable WS6: surface codemem hits for the goal in a loop's first prompt. */
  loopSurfaceCodemem: boolean;
  /** Fable WS6: surface prior lessons/learnings in a loop's first prompt. */
  loopSurfaceLessons: boolean;
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
   * Attach the `chrome-devtools` MCP server to a Harness-managed browser profile.
   * When enabled, spawned agents get a chrome-devtools server configured with
   * `--browserUrl` pointing at the managed profile's CDP endpoint, so they can
   * drive the same authenticated browser they opened via `browser.*`.
   */
  chromeDevtoolsAttachEnabled: boolean;
  /** Managed browser profile id chrome-devtools attaches to (empty = none). */
  chromeDevtoolsAttachProfileId: string;

  /**
   * Path to a local file containing the Bitwarden master password used to
   * unlock the browser credential vault. The path is stored — the password
   * itself is read at unlock time, kept in main-process memory only, and never
   * logged or sent to the renderer/model. Empty = unlock unavailable.
   * Overridable with the AIO_BW_MASTER_PASSWORD_FILE env var.
   */
  browserVaultMasterPasswordFile: string;
  /**
   * When true, the browser credential vault auto-unlocks at gateway startup
   * from the configured master-password file — no UI click needed for
   * unattended runs. Default OFF: the vault stays locked on launch unless the
   * operator explicitly opts into hands-free unlocking. Requires a readable
   * master-password source (setting or AIO_BW_MASTER_PASSWORD_FILE).
   */
  browserVaultAutoUnlock: boolean;
  /**
   * WS11.2 "big model asks, small model reads": when true, browser.snapshot
   * calls that carry an extractionHint run the captured page text through the
   * auxiliary `webExtract` slot and return the distilled extract (never-worse
   * guarded) instead of the raw dump. Default OFF.
   */
  browserAuxExtractionEnabled: boolean;
  /**
   * WS9 tool-schema economy: when true (default), spawned CLI sessions get a
   * deferred browser-gateway tool surface — a small always-loaded core set
   * plus `browser.tool_search`/`browser.tool_describe` that load the remaining
   * tool schemas on demand — instead of paying the full ~39-schema context tax
   * upfront. Applies at the next session spawn.
   */
  browserMcpToolDeferral: boolean;
  /**
   * Runtime-reconciler spec item 5: maintain a per-instance rolling handoff
   * document as turns complete and prefer it over the swap-time replay
   * preamble for provider swaps and history-restore fallbacks. Default OFF
   * (behavior preservation) until provider-swap live testing motivates it.
   */
  sessionHandoffStateEnabled: boolean;
  /**
   * WS14 — Claude `--fallback-model`: when set, Claude sessions automatically
   * retry with this model when the primary is overloaded. Empty = off.
   */
  claudeFallbackModel: string;
  /**
   * WS14 — `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` on Claude spawns. Default OFF:
   * the scrub could strip the ORCHESTRATOR_* vars AIO's PreToolUse hook and
   * RTK read from subprocess env. Flip only with livetest evidence.
   */
  claudeSubprocessEnvScrub: boolean;
  /**
   * WS16 — block agent-derived memories from system-prompt-tier assembly
   * (they may only appear in labelled advisory blocks). Default ON.
   */
  memoryInstructionGate: boolean;
  /**
   * WS7 Phase B — ordered fallback providers a regular session may fail over to
   * when its recovery ladder exhausts on a provider-fault category. Empty = off.
   * Configuring this is explicit consent to send conversation context to those
   * providers. Seeded onto each new instance's `failoverProviders` at create.
   */
  sessionFailoverProviders: string[];
  /** WS7 Phase B — max automatic provider failovers per session. Default 1. */
  sessionFailoverMaxSwitches: number;
  /**
   * WS7 Phase B — when a provider-limit park's resume is further away than
   * this, offer a provider switch (notification + composer button emphasis).
   */
  sessionFailoverOfferAfterMinutes: number;
  /**
   * WS12 instruction trust gate for PROJECT-sourced instruction files
   * (CLAUDE.md/AGENTS.md/… discovered in repos). 'warn' (default, measurement
   * release): load + surface unapproved/changed files. 'enforce': unapproved,
   * changed, or critically-flagged files are SKIPPED (not warned). 'off':
   * pre-WS12 behavior. User-global files are exempt by design.
   */
  instructionTrustGate: 'off' | 'warn' | 'enforce';
  /**
   * When true, browser.fill_credential and the credential steps of
   * browser.execute_fill_plan may run on the user's SHARED existing Chrome tabs
   * (not just agent-owned managed profiles) — but ONLY when a live standing
   * CredentialAuthorization also covers the node-scoped profile + live origin +
   * purpose. Default OFF: shared tabs stay fully locked to manual login. The
   * secret is still resolved in-process and typed straight into the page; it
   * never enters model context or the audit log. Operator-only (not agent
   * writable via the safe settings tool). See
   * bigchange_shared-tab-autonomous-login_2026-07-10.md.
   */
  browserAllowSharedTabCredentialFill: boolean;

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
   * When true, a *regular* (non-loop) interactive instance that stops on a
   * provider rate/session-limit is parked and automatically resumed after the
   * quota-reset window — its throttled turn is re-sent. Mirrors the loop
   * coordinator's provider-limit auto-resume, but for plain chat sessions.
   * Default OFF: unattended resumes can spend quota while the user is away.
   */
  instanceProviderLimitResumeEnabled: boolean;
  /** Enable early warnings when known quota windows are consumed ahead of time. */
  quotaPacingWarningEnabled: boolean;
  /** Utilization percentage that begins an ahead-of-window pacing warning. */
  quotaPacingUtilizationThresholdPercent: number;
  /** Latest elapsed-window percentage eligible for a pacing warning. */
  quotaPacingLatestElapsedPercent: number;
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
  crossModelReviewProviders: RemoteReviewerProvider[];
  crossModelReviewTimeout: number;
  crossModelReviewTypes: string[];
  /**
   * Optional per-reviewer-CLI model override for cross-model review.
   * Keys are reviewer CLI names (e.g. 'copilot', 'antigravity', 'codex', 'cursor').
   * A missing entry, an empty string, or 'auto' means "let that provider's CLI
   * decide" — we pass no model and the CLI uses its own default/auto routing
   * (e.g. Copilot auto-routes to a GPT model). A concrete model id is forwarded
   * to the reviewer adapter as its model. This does NOT fall back to
   * getPrimaryModelForProvider, so the default behaviour is true CLI routing.
   */
  crossModelReviewModelByProvider: Record<string, string>;
  /**
   * Per-provider model for NON-INTERACTIVE automation (loop iterations and the
   * orchestration invokers). Keys are CLI names ('claude', 'codex', …).
   *
   * This exists because loops do NOT go through the interactive new-session
   * path: they resolve their model from `getDefaultModelForCli()`, so they
   * silently inherit whatever the interactive default happens to be. On
   * 2026-07-10 the codex interactive default moved to `gpt-5.6-sol` and every
   * loop iteration moved with it — flagship rates on the highest-volume path,
   * with no user-facing control and no way to see it had happened.
   *
   * A missing entry or an empty string means "fall back to the provider's
   * interactive default", which is the pre-existing behaviour. Interactive
   * sessions are unaffected by this setting.
   */
  loopModelByProvider: Record<string, string>;
  crossModelReviewLocalEnabled: boolean;
  crossModelReviewLocalSelectorId: string;
  crossModelReviewLocalTimeout: number;
  crossModelReviewLocalMaxToolRounds: number;

  // Conversational ping-pong review (bigchange_pingpong_review)
  /**
   * Default reviewer provider for ping-pong mode. `'auto'` pairs Claude ⇄ Codex:
   * the reviewer is always the *other* member of that pair from the builder
   * (Claude builds → Codex reviews, and vice versa) before widening to another
   * installed non-builder provider if the pair is unavailable. To prefer
   * Antigravity/Copilot/etc., set an explicit provider here. A per-run override
   * exists in the loop control.
   */
  pingPongReviewerProvider: CanonicalCliType;
  /** Default hard cap on ping-pong rounds (clamped 1..20). */
  pingPongMaxRounds: number;

  // Voice STT
  voiceSttRoutingMode: VoiceSttRoutingMode;
  voiceLocalSttEnabled: boolean;
  voiceLocalSttWorkerNodeId: string;
  voiceLocalSttModel: string;
  voiceLocalSttLanguage: string;
  voiceThisDeviceSttEndpointUrl: string;
  voiceThisDeviceSttApiKeyEnv: string;
  voiceLocalSttMaxSegmentMs: number;

  // Remote Nodes
  workerMode: WorkerModeSettings;
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
  /** Microsoft public-client application id. Non-secret; empty disables Graph auth. */
  graphClientId: string;
  /** Microsoft identity authority used by delegated Graph authentication. */
  graphAuthority: string;
  /** JSON array of delegated Microsoft Graph scopes requested during consent. */
  graphScopesJson: string;
  /** JSON array of account emails agents may mutate; reads remain available to all connected accounts. */
  graphAgentWritableAccountsJson: string;
  // RTK (Rust Token Killer) — compresses LLM-bound shell command output 60–90%.
  // See bigchange_rtk_integration.md for details. On by default; users can opt out
  // via the RTK Savings settings tab.
  rtkEnabled: boolean;
  /** When true, never use a system-installed rtk; only the bundled binary. */
  rtkBundledOnly: boolean;

  // Notifications
  /** Show a desktop notification when an agent transitions from busy to idle. Default: true. */
  notifyOnAgentCompletion: boolean;
  /** Minimum interval between desktop notifications of the same kind. */
  notificationCooldownSeconds: number;
  /** Keep normal-priority desktop notifications in the in-app center overnight. */
  notificationQuietHoursEnabled: boolean;
  /** Inclusive local-hour start for quiet hours (0–23). */
  notificationQuietHoursStartHour: number;
  /** Exclusive local-hour end for quiet hours (0–23). */
  notificationQuietHoursEndHour: number;
  /**
   * When true, the chat-channel bots (Discord/WhatsApp) post an occasional,
   * throttled "still working…" heartbeat while an agent runs a long, silent
   * turn full of tool calls. Off by default to keep channels quiet.
   */
  channelToolHeartbeat: boolean;

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
  /**
   * Project plugin execution trust map keyed by canonical project root.
   * Missing roots default to `ask`, which surfaces manifest metadata but does
   * not import project plugin code until trust is granted.
   */
  projectPluginTrust: Record<string, ProjectPluginTrust>;

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
  /** Optional hard daily USD ceiling for metered auxiliary cloud calls. */
  auxiliaryLlmDailySpendCapUsd: number | null;
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

  /**
   * Operator-controlled model tier per orchestration gate, as JSON.
   *
   * Before this existed, the tier for each gate was hardcoded in
   * `resolveModelForInvocation`: loop/verify/review/debate/debateSynthesis were
   * pinned to `balanced` and workflow used keyword-complexity routing. That is
   * still the default here, so behaviour is unchanged until you override a key.
   *
   * `auto` means "fall back to the router's keyword-complexity heuristic".
   * Any other value pins that gate to a fixed tier.
   *
   * This is the cheapest lever on orchestration spend: reviews and verifies are
   * bounded, read-only, diff-shaped tasks, so `{"review":"fast","verify":"fast"}`
   * moves them off the expensive tier without touching any code. Conversely a
   * gate that is producing weak output can be raised in isolation.
   *
   * @see DEFAULT_ORCHESTRATION_ROUTING_POLICY
   */
  orchestrationRoutingPolicyJson: string;

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

export { SETTINGS_METADATA } from './settings-metadata';
export type { SettingMetadata } from './settings-metadata';
export {
  LEGACY_PROJECT_CONFIG_FILE,
  mergeConfigs,
  PROJECT_CONFIG_FILE,
} from './project-config.types';
export type { ProjectConfig, ResolvedConfig } from './project-config.types';
