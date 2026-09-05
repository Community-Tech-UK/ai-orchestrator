/**
 * Default values for the persisted application settings.
 *
 * Split out of settings.types.ts (which owns the AppSettings shape) so the
 * shape and the shipped defaults can evolve without one file carrying both.
 * Everything here is re-exported from settings.types.ts, so importers keep
 * using that module. Only `import type` from settings.types.ts is allowed in
 * this file — a value import would create a runtime module cycle.
 */

import type {
  AppSettings,
  OrchestrationRoutingPolicyKey,
  OrchestrationRoutingPolicyValue,
} from './settings.types';
import { DEFAULT_DESKTOP_COMPUTER_USE_SETTINGS } from './desktop-gateway-settings.types';
import type { RemoteReviewerProvider } from './reviewer-provider.types';
import { CLAUDE_MODELS, COPILOT_MODELS, GOOGLE_MODELS, GROK_MODELS, OPENAI_MODELS } from './provider.types';

export const DEFAULT_CONTEXT_EVIDENCE_MODE_BY_PROVIDER = Object.freeze({
  claude: 'off',
  codex: 'off',
  gemini: 'off',
  antigravity: 'off',
  copilot: 'off',
  cursor: 'off',
  grok: 'off',
} as const);

/**
 * Explicit reviewer model per provider.
 *
 * Every reviewer provider gets an entry on purpose. When a provider is absent
 * from this map the reviewer passes NO model and inherits the provider CLI's
 * own default — which means our review cost silently tracks whatever the
 * upstream CLI decides to promote, with no signal to the user. That is exactly
 * how codex reviews ended up on a flagship model.
 *
 * Reviewing a diff and emitting a structured verdict is a bounded judgement
 * task: large input, small output, no long-horizon planning. It does not need a
 * flagship reasoning model, so each entry is the provider's balanced tier.
 * 'auto' or an empty string in settings still means "let the CLI decide" for
 * anyone who explicitly wants that.
 */
export const DEFAULT_REVIEWER_MODEL_BY_PROVIDER: Readonly<Record<RemoteReviewerProvider, string>> = {
  claude: CLAUDE_MODELS.SONNET,
  codex: OPENAI_MODELS.GPT56_TERRA,
  antigravity: 'Gemini 3.5 Flash (Medium)',
  copilot: COPILOT_MODELS.CLAUDE_SONNET_46,
  cursor: 'composer-2.5',
  grok: GROK_MODELS.GROK_46,
};

/**
 * Model used by loop iterations and the orchestration invokers, per provider.
 *
 * T41: every pin here matches what the router's `balanced` tier already picks
 * for a loop, so the pin changes nothing while routing is on — it stops the
 * house flagship default riding the highest-volume path when routing is off or
 * skipped, which is the only case that was ever surprising.
 *
 *   - codex → Terra: within ~1.2pt of Sol on SWE-Bench Pro and ~1.4pt on
 *     Terminal-Bench 2.1 at half the output rate.
 *   - claude → Sonnet: the balanced tier. Unpinned, a router-off loop rode
 *     Opus (or Opus-1M for a new chat) on every iteration.
 *   - gemini → Gemini 3 Flash: the balanced tier. Unpinned, router-off landed
 *     on Gemini 3.1 Pro.
 *   - grok → grok-4.6: Grok has NO balanced row, so `applyProviderResolution`
 *     warned and passed the Claude decision through unchanged; `sonnet` then
 *     reached `createCliAdapter('grok')`, was repaired to grok-4.6, and the HUD
 *     showed a Claude id while the flagship ran. Pinning the id that actually
 *     runs makes the display honest. Raise this the day a cheaper Grok id
 *     appears on the live `grok models` list (G34).
 *
 * Copilot is deliberately absent: it is an EBRD-only seat, its first balanced
 * row is Claude Sonnet 4.6, and silently retargeting it is out of scope.
 * `providersExcludedFromAutomation` still gates any automatic choice.
 */
export const DEFAULT_LOOP_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  codex: OPENAI_MODELS.GPT56_TERRA,
  claude: CLAUDE_MODELS.SONNET,
  gemini: GOOGLE_MODELS.GEMINI_3_FLASH,
  grok: GROK_MODELS.GROK_46,
};

/**
 * Defaults chosen to REPRODUCE the previously-hardcoded behaviour in
 * `resolveModelForInvocation` exactly, so introducing this setting changes
 * nothing until an operator overrides a key:
 *
 *   - loop / verify / review / debate / debateSynthesis -> `balanced`.
 *     `synthesis` was pinned to balanced deliberately: the claude-fanout audit
 *     measured debate synthesis on the powerful tier as the single most
 *     expensive call, at 38.3% of that run's spend. Do not raise it casually.
 *   - workflow -> `auto`. Workflow prompts are caller-authored tasks rather than
 *     a fixed template, so keyword-complexity routing still applies.
 */
export const DEFAULT_ORCHESTRATION_ROUTING_POLICY: Readonly<
  Record<OrchestrationRoutingPolicyKey, OrchestrationRoutingPolicyValue>
> = Object.freeze({
  loop: 'balanced',
  workflow: 'auto',
  verify: 'balanced',
  review: 'balanced',
  debate: 'balanced',
  debateSynthesis: 'balanced',
});

export const DEFAULT_ORCHESTRATION_ROUTING_POLICY_JSON = JSON.stringify(
  DEFAULT_ORCHESTRATION_ROUTING_POLICY,
);

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
  automationDefaultCli: 'auto',
  automationDefaultModel: '',
  defaultFastMode: false,
  defaultFastModeByProvider: {},
  modelUsageByKey: {},
  modelPickerFavorites: [],
  residentClaudeSession: true,
  contextEvidenceModeByProvider: { ...DEFAULT_CONTEXT_EVIDENCE_MODE_BY_PROVIDER },
  theme: 'dark',

  // Orchestration
  maxChildrenPerParent: 10,
  maxTotalInstances: 20,
  autoTerminateIdleMinutes: 30,
  allowNestedOrchestration: false,
  maxSpawnDepth: 3,
  docReviewResumeOnSubmit: true,
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

  // Keyboard (WS-C9)
  /**
   * User keybinding overrides, serialized via
   * `serializeKeybindingCustomizations` (`{version:1, customizations:[...]}`
   * JSON). Empty string = no overrides. Loaded/saved by KeybindingService;
   * see core/keybindings/keybinding-registry.ts.
   */
  keybindingCustomizations: '',

  // Advanced
  customModelOverride: '',
  customModelsByProvider: {},
  modelCatalogRemoteOverrideUrl: '',
  parserBufferMaxKB: 1024, // 1MB max parser buffer
  codememEnabled: true,
  // Fable WS6: PLAN-stage prior context surfacing (both default ON).
  loopSurfaceCodemem: true,
  loopSurfaceLessons: true,
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
  browserVaultMasterPasswordFile: '',
  browserVaultAutoUnlock: false,
  browserAuxExtractionEnabled: false,
  // Decision 6 (fable plan review, 2026-07-13): deferred by default.
  browserMcpToolDeferral: true,
  // Spec item 5: flipped ON 2026-08-18 on the evidence check 5 actually asks for —
  // a quality comparison across two real 32-turn Claude sessions (ON and OFF),
  // judged on the delivered continuity documents rather than on the model's
  // answer. That distinction mattered: asking the swapped session directly gave
  // a FALSE POSITIVE on the OFF path, because RLM/project-memory injection fires
  // on every ordinary turn independently of this setting and supplied the answer
  // the replay preamble had actually dropped. Reconstructing the real documents
  // instead (same pure functions, pre-swap messages only): the OFF preamble
  // reconstructed to 11,824 chars — an exact match for the logged documentChars,
  // confirming fidelity — and did NOT contain the early decision anywhere, while
  // the ON rolling summary did, inside its folded-summary section.
  // An earlier same-day flip was reverted when the only evidence was a one-turn
  // session (nothing folds in one turn, so the two paths are indistinguishable);
  // this flip rests on the 30+-turn comparison instead.
  sessionHandoffStateEnabled: true,
  // WS16: agent-derived memories never reach system-prompt tier by default.
  memoryInstructionGate: true,
  // WS14: empty = no automatic overload fallback model.
  claudeFallbackModel: '',
  // WS14: OFF until the livetest proves hooks/RTK survive the scrub.
  claudeSubprocessEnvScrub: false,
  // WS7 Phase B: empty = failover off (explicit opt-in consent).
  sessionFailoverProviders: [],
  sessionFailoverMaxSwitches: 1,
  sessionFailoverOfferAfterMinutes: 30,
  // WS12: warn-mode measurement release first; enforce is the end-state.
  instructionTrustGate: 'warn',
  browserAllowSharedTabCredentialFill: false,
  workspaceSecretsEnabled: true,
  workspaceSecretsAllowAgentRequests: true,

  // Regular-session provider-limit auto-resume (default OFF — see interface doc)
  instanceProviderLimitResumeEnabled: false,
  loopAllowProviderOverage: false,
  quotaPacingWarningEnabled: true,
  quotaPacingUtilizationThresholdPercent: 90,
  quotaPacingLatestElapsedPercent: 72,

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
  crossModelReviewModelByProvider: { ...DEFAULT_REVIEWER_MODEL_BY_PROVIDER },
  loopModelByProvider: { ...DEFAULT_LOOP_MODEL_BY_PROVIDER },
  crossModelReviewLocalEnabled: true,
  crossModelReviewLocalSelectorId: '',
  crossModelReviewLocalTimeout: 120,
  crossModelReviewLocalMaxToolRounds: 12,
  providersExcludedFromAutomation: [],

  // GitHub Copilot account routing. Empty until the legacy-profile migration
  // runs on first launch (settings-migrations.ts), which binds the existing
  // copilot-cli-home directory to a default profile without moving any files.
  copilotAccountProfiles: [],
  copilotAccountRoutingRules: [],

  // Conversational ping-pong review
  pingPongReviewerProvider: 'auto',
  pingPongMaxRounds: 15,

  // Voice STT
  voiceSttRoutingMode: 'auto',
  voiceLocalSttEnabled: true,
  voiceLocalSttWorkerNodeId: '',
  voiceLocalSttModel: '',
  voiceLocalSttLanguage: 'en',
  voiceThisDeviceSttEndpointUrl: '',
  voiceThisDeviceSttApiKeyEnv: '',
  voiceLocalSttMaxSegmentMs: 5000,

  // Remote Nodes
  workerMode: { role: 'unset', startWorkerOnLaunch: true, installWorkerService: false },
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
  // The registered app is currently single-tenant, so Microsoft requires a
  // tenant-specific authority (AADSTS50194 rejects /common for this audience).
  graphClientId: 'fdbb0672-4089-48dc-bcc5-7121a331fcfc',
  graphAuthority: 'https://login.microsoftonline.com/60b0a25e-b75d-4d9e-b797-1805ec311dfb',
  graphScopesJson: JSON.stringify([
    'Calendars.ReadWrite',
    'offline_access',
    'openid',
    'profile',
    'User.Read',
  ]),
  graphAgentWritableAccountsJson: JSON.stringify(['james@communitytech.co.uk']),
  ...DEFAULT_DESKTOP_COMPUTER_USE_SETTINGS,
  // RTK
  rtkEnabled: true,
  rtkBundledOnly: false,

  // Notifications
  notifyOnAgentCompletion: true,
  channelToolHeartbeat: false,
  notificationCooldownSeconds: 30,
  notificationQuietHoursEnabled: false,
  notificationQuietHoursStartHour: 22,
  notificationQuietHoursEndHour: 7,

  // CLI Provider Updates
  cliUpdatePolicy: 'notify',

  // E14 — repo-map injection
  injectRepoMap: true,
  repoMapTokenBudget: 2_000,

  // A3 — adapter-layer degraded-output detection (off by default)
  detectDegradedAdapterOutput: false,

  // WS-A2 — auto-interrupt on a critical tool-loop detection (off by default)
  toolLoopAutoInterrupt: false,

  // WS-B3 — opt-in Guardian adjudicator for unattended approval asks (off by default)
  approvalAdjudicationEnabled: false,

  // D4 — CLI spawn worker offload pilot (off by default)
  enableSpawnWorkerOffload: false,
  projectPluginTrust: {},

  // WS-B1 phase 1 — PR creation is opt-in per project (off by default)
  allowPrCreation: {},

  // Reactions
  reactionsEnabled: true,
  reactionsPollIntervalMs: 60_000,

  // Auxiliary LLM
  auxiliaryLlmEnabled: true,
  auxiliaryLlmRoutingMode: 'local-first',
  auxiliaryLlmAllowRemoteWorkerModels: true,
  auxiliaryLlmUseLocalhostOllama: true,
  auxiliaryLlmDailySpendCapUsd: null,
  auxiliaryLlmEndpointsJson: '[]',
  auxiliaryLlmQuickModel: '',
  auxiliaryLlmQualityModel: '',
  auxiliaryLlmRoutingClassificationEnabled: true,
  localAiGuardDefaultFallbackPolicy: 'notify-and-allow',
  localAiGuardDailyFallbackBudgetUsd: null,
  localAiGuardConfirmAboveInputTokens: null,
  orchestrationRoutingPolicyJson: DEFAULT_ORCHESTRATION_ROUTING_POLICY_JSON,
  auxiliaryLlmSlotsJson: JSON.stringify({
    compression: { enabled: true, provider: 'auto', tier: 'quality', maxInputTokens: 96000, maxOutputTokens: 4096, temperature: 0.2, timeoutMs: 60000, requireJson: false, allowFrontierFallback: true },
    memoryDistillation: { enabled: true, provider: 'auto', tier: 'quality', maxInputTokens: 64000, maxOutputTokens: 2048, temperature: 0.2, timeoutMs: 45000, requireJson: false, allowFrontierFallback: true },
    webExtract: { enabled: true, provider: 'auto', tier: 'quality', maxInputTokens: 64000, maxOutputTokens: 2048, temperature: 0.1, timeoutMs: 30000, requireJson: false, allowFrontierFallback: false },
    titleGeneration: { enabled: true, provider: 'auto', tier: 'quick', maxInputTokens: 12000, maxOutputTokens: 512, temperature: 0.2, timeoutMs: 45000, requireJson: false, allowFrontierFallback: false },
    routingClassification: { enabled: true, provider: 'auto', tier: 'quick', maxInputTokens: 16000, maxOutputTokens: 512, temperature: 0, timeoutMs: 45000, requireJson: true, allowFrontierFallback: false },
    approvalScoring: { enabled: true, provider: 'auto', tier: 'quick', maxInputTokens: 16000, maxOutputTokens: 512, temperature: 0, timeoutMs: 45000, requireJson: true, allowFrontierFallback: false },
    approvalAdjudication: { enabled: true, provider: 'auto', tier: 'quality', maxInputTokens: 24000, maxOutputTokens: 512, temperature: 0, timeoutMs: 60000, requireJson: true, allowFrontierFallback: false },
    loopScoring: { enabled: true, provider: 'auto', tier: 'quick', maxInputTokens: 32000, maxOutputTokens: 1024, temperature: 0, timeoutMs: 30000, requireJson: true, allowFrontierFallback: false },
    retrievalHypothesis: { enabled: true, provider: 'auto', tier: 'quick', maxInputTokens: 4096, maxOutputTokens: 300, temperature: 0.3, timeoutMs: 2500, requireJson: false, allowFrontierFallback: false },
    branchScoring: { enabled: true, provider: 'auto', tier: 'quick', maxInputTokens: 16000, maxOutputTokens: 512, temperature: 0, timeoutMs: 30000, requireJson: true, allowFrontierFallback: true },
    subQueryExecution: { enabled: false, provider: 'auto', tier: 'quality', maxInputTokens: 64000, maxOutputTokens: 2048, temperature: 0.2, timeoutMs: 45000, requireJson: false, allowFrontierFallback: true },
    verifyOutputSummary: { enabled: true, provider: 'auto', tier: 'quality', maxInputTokens: 32000, maxOutputTokens: 1024, temperature: 0.2, timeoutMs: 45000, requireJson: false, allowFrontierFallback: false },
  }),

  // WS-C10 — flagged transcript DOM virtualization (off by default; see settings.types.ts)
  transcriptVirtualization: false,
};
