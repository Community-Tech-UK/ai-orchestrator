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
import { CLAUDE_MODELS, COPILOT_MODELS, GROK_MODELS, OPENAI_MODELS } from './provider.types';

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
  grok: GROK_MODELS.GROK_45,
};

/**
 * Model used by loop iterations and the orchestration invokers, per provider.
 *
 * Only codex is pinned: Terra scores within ~1.2pt of Sol on SWE-Bench Pro and
 * ~1.4pt on Terminal-Bench 2.1 at half the output rate, which is the right
 * trade for a high-volume automated path. Providers left unset keep resolving
 * to their interactive default, so this change is scoped to the burn we
 * actually measured rather than silently re-tiering every provider.
 */
export const DEFAULT_LOOP_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  codex: OPENAI_MODELS.GPT56_TERRA,
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
  defaultFastMode: false,
  defaultFastModeByProvider: {},
  modelUsageByKey: {},
  residentClaudeSession: true,
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

  // Advanced
  customModelOverride: '',
  customModelsByProvider: {},
  modelCatalogRemoteOverrideUrl: '',
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
  browserVaultMasterPasswordFile: '',
  browserVaultAutoUnlock: false,
  browserAllowSharedTabCredentialFill: false,

  // Regular-session provider-limit auto-resume (default OFF — see interface doc)
  instanceProviderLimitResumeEnabled: false,
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
  ...DEFAULT_DESKTOP_COMPUTER_USE_SETTINGS,
  // RTK
  rtkEnabled: true,
  rtkBundledOnly: false,

  // Notifications
  notifyOnAgentCompletion: true,
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

  // D4 — CLI spawn worker offload pilot (off by default)
  enableSpawnWorkerOffload: false,
  projectPluginTrust: {},

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
  orchestrationRoutingPolicyJson: DEFAULT_ORCHESTRATION_ROUTING_POLICY_JSON,
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
    verifyOutputSummary: { enabled: true, provider: 'auto', tier: 'quality', maxInputTokens: 32000, maxOutputTokens: 1024, temperature: 0.2, timeoutMs: 45000, requireJson: false, allowFrontierFallback: false },
  }),
};
