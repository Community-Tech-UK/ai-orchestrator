/**
 * S2.1 — every setting declares HOW it surfaces, so "this key has no UI" is a
 * decision on the record rather than an oversight.
 *
 * The gap this closes, measured: `AppSettings` has 190 keys and
 * `SETTINGS_METADATA` covered 126 of them. The other 64 had no declaration
 * anywhere — not hidden, not internal, just absent, and nothing failed.
 *
 * The `satisfies Record<keyof AppSettings, SettingSurfacing>` below is the
 * load-bearing part: adding a key to `AppSettings` now fails to compile until
 * someone classifies it. That is the difference between a list that happens to
 * be complete today and one that cannot silently rot.
 *
 * The classifications are derived from how each key ACTUALLY surfaces today,
 * not from how anyone thinks it should:
 *  - `tab`      — has metadata and appears in a category-driven tab.
 *  - `bespoke`  — a dedicated tab owns it. That is EITHER a metadata entry
 *                 marked `hidden` (selected by explicit key), OR a hand-coded
 *                 picker that never enters `SETTINGS_METADATA` at all. The
 *                 second case was originally misfiled as `internal`, because the
 *                 spec only cross-checked against `SETTINGS_METADATA` and so
 *                 could not see a bespoke picker — exhaustive, but not true.
 *  - `internal` — no metadata: not user-editable through the settings UI at
 *                 all. Many are legitimately internal (usage counters, learned
 *                 model memory, enrollment tokens, per-provider maps written by
 *                 other surfaces). Some are arguably missing UI. This registry
 *                 does not adjudicate that — it makes the set visible and
 *                 reviewable, which it was not before.
 *  - `hidden`   — reserved for a key deliberately withheld from every surface.
 *                 Nothing uses it yet; it exists so "withheld" and "has no UI"
 *                 stay distinguishable.
 */

import type { AppSettings } from './settings.types';

export type SettingSurfacing = 'tab' | 'bespoke' | 'hidden' | 'internal';

export const SETTING_SURFACING = {
  defaultYoloMode: 'tab',
  defaultWorkingDirectory: 'tab',
  defaultCli: 'tab',
  defaultModel: 'tab',
  // Written by the general-settings model picker (store.update at :250).
  defaultModelByProvider: 'bespoke',
  // Edited by the general-settings-tab picker, not by a metadata-driven row.
  automationDefaultCli: 'bespoke',
  // Edited by the general-settings-tab picker, not by a metadata-driven row.
  automationDefaultModel: 'bespoke',
  defaultFastMode: 'tab',
  defaultFastModeByProvider: 'internal',
  modelUsageByKey: 'internal',
  modelPickerFavorites: 'internal',
  residentClaudeSession: 'internal',
  contextEvidenceModeByProvider: 'internal',
  theme: 'tab',
  maxChildrenPerParent: 'tab',
  maxTotalInstances: 'tab',
  autoTerminateIdleMinutes: 'tab',
  allowNestedOrchestration: 'tab',
  maxSpawnDepth: 'tab',
  docReviewResumeOnSubmit: 'tab',
  defaultMissedRunPolicy: 'tab',
  outputBufferSize: 'tab',
  enableDiskStorage: 'tab',
  maxDiskStorageMB: 'tab',
  memoryWarningThresholdMB: 'tab',
  autoTerminateOnMemoryPressure: 'tab',
  persistSessionContent: 'tab',
  cumulativeTokenCompactionTrigger: 'tab',
  outputStyle: 'tab',
  fontSize: 'tab',
  displayDensity: 'tab',
  sidebarStyle: 'tab',
  contextWarningThreshold: 'tab',
  showToolMessages: 'tab',
  showThinking: 'tab',
  thinkingDefaultExpanded: 'tab',
  showCost: 'tab',
  maxRecentDirectories: 'tab',
  // Edited by the "Import shortcuts" textarea on the Keyboard tab
  // (`keyboard-settings-tab.component.ts` `onImport`), which writes through
  // `KeybindingService` — so the key name never appears in the settings folder.
  keybindingCustomizations: 'bespoke',
  customModelOverride: 'bespoke',
  customModelsByProvider: 'bespoke',
  modelCatalogRemoteOverrideUrl: 'tab',
  parserBufferMaxKB: 'tab',
  codememEnabled: 'tab',
  loopSurfaceCodemem: 'internal',
  loopSurfaceLessons: 'internal',
  codememIndexingEnabled: 'tab',
  codememLspWorkerEnabled: 'tab',
  codememPrewarmEnabled: 'tab',
  codememPrewarmMaxConcurrent: 'tab',
  codememPrewarmDebounceMs: 'tab',
  codememPrewarmStartupHint: 'tab',
  commandDiagnosticsAvailable: 'tab',
  broadRootFileThreshold: 'tab',
  chromeDevtoolsAttachEnabled: 'tab',
  chromeDevtoolsAttachProfileId: 'tab',
  browserVaultMasterPasswordFile: 'tab',
  browserVaultAutoUnlock: 'tab',
  browserAuxExtractionEnabled: 'internal',
  browserMcpToolDeferral: 'tab',
  sessionHandoffStateEnabled: 'tab',
  claudeFallbackModel: 'tab',
  claudeSubprocessEnvScrub: 'tab',
  memoryInstructionGate: 'tab',
  sessionFailoverProviders: 'tab',
  sessionFailoverMaxSwitches: 'tab',
  sessionFailoverOfferAfterMinutes: 'tab',
  instructionTrustGate: 'tab',
  browserAllowSharedTabCredentialFill: 'tab',
  workspaceSecretsEnabled: 'tab',
  workspaceSecretsAllowAgentRequests: 'tab',
  codebaseAutoIndexEnabled: 'tab',
  instanceProviderLimitResumeEnabled: 'tab',
  loopAllowProviderOverage: 'tab',
  quotaPacingWarningEnabled: 'tab',
  quotaPacingUtilizationThresholdPercent: 'tab',
  quotaPacingLatestElapsedPercent: 'tab',
  codebaseAutoIndexMaxFiles: 'tab',
  codebaseAutoIndexMaxBytes: 'tab',
  codebaseAutoIndexConcurrent: 'tab',
  codebaseAutoIndexDebounceMs: 'tab',
  codebaseAutoIndexStartupHint: 'tab',
  projectKnowledgeAutoMirrorEnabled: 'tab',
  projectKnowledgeAutoMirrorDebounceMs: 'tab',
  projectKnowledgeAutoMirrorMaxConcurrent: 'tab',
  projectKnowledgeAutoMirrorSkipWithinMs: 'tab',
  projectKnowledgeAutoMirrorStartupHint: 'tab',
  crossModelReviewEnabled: 'tab',
  crossModelReviewDepth: 'tab',
  crossModelReviewMaxReviewers: 'tab',
  crossModelReviewProviders: 'tab',
  crossModelReviewTimeout: 'tab',
  crossModelReviewTypes: 'tab',
  // Edited by the review-settings-tab picker, not by a metadata-driven row.
  crossModelReviewModelByProvider: 'bespoke',
  // Edited by the orchestration-settings-tab picker, not by a metadata-driven row.
  loopModelByProvider: 'bespoke',
  crossModelReviewLocalEnabled: 'tab',
  crossModelReviewLocalSelectorId: 'tab',
  crossModelReviewLocalTimeout: 'tab',
  crossModelReviewLocalMaxToolRounds: 'tab',
  providersExcludedFromAutomation: 'tab',
  copilotAccountProfiles: 'bespoke',
  copilotAccountRoutingRules: 'bespoke',
  pingPongReviewerProvider: 'tab',
  pingPongMaxRounds: 'tab',
  voiceSttRoutingMode: 'bespoke', // voice tab
  voiceLocalSttEnabled: 'bespoke', // voice tab
  voiceLocalSttWorkerNodeId: 'bespoke', // voice tab
  voiceLocalSttModel: 'bespoke', // voice tab
  voiceLocalSttLanguage: 'bespoke', // voice tab
  voiceThisDeviceSttEndpointUrl: 'bespoke', // voice tab
  voiceThisDeviceSttApiKeyEnv: 'bespoke', // voice tab
  voiceLocalSttMaxSegmentMs: 'bespoke', // voice tab
  workerMode: 'bespoke', // remote-nodes tab
  remoteNodesEnabled: 'bespoke', // remote-nodes tab
  remoteNodesServerPort: 'bespoke', // remote-nodes tab
  remoteNodesServerHost: 'bespoke', // remote-nodes tab
  remoteNodesEnrollmentToken: 'bespoke', // remote-nodes tab
  remoteNodesAutoOffloadBrowser: 'bespoke', // remote-nodes tab
  remoteNodesAutoOffloadAndroid: 'bespoke', // remote-nodes tab
  remoteNodesAutoOffloadGpu: 'bespoke', // remote-nodes tab
  remoteNodesNamespace: 'bespoke', // remote-nodes tab
  remoteNodesRequireTls: 'bespoke', // remote-nodes tab
  remoteNodesTlsMode: 'bespoke', // remote-nodes tab
  remoteNodesTlsCertPath: 'internal',
  remoteNodesTlsKeyPath: 'internal',
  remoteNodesRegisteredNodes: 'internal',
  thinClientWsEnabled: 'internal',
  thinClientWsHost: 'internal',
  thinClientWsPort: 'internal',
  mobileGatewayEnabled: 'internal',
  mobileGatewayPort: 'internal',
  mobileGatewayBindInterface: 'internal',
  mobileGatewayDevices: 'internal',
  mobileGatewayTlsCertPath: 'bespoke', // mobile tab
  mobileGatewayTlsKeyPath: 'bespoke', // mobile tab
  mobileGatewayApnsKeyP8: 'bespoke', // mobile tab
  mobileGatewayApnsKeyId: 'bespoke', // mobile tab
  mobileGatewayApnsTeamId: 'bespoke', // mobile tab
  mobileGatewayApnsBundleId: 'bespoke', // mobile tab
  mobileGatewayApnsProduction: 'bespoke', // mobile tab
  pauseFeatureEnabled: 'tab',
  pauseOnVpnEnabled: 'tab',
  pauseVpnInterfacePattern: 'tab',
  pauseTreatExistingVpnAsActive: 'tab',
  pauseDetectorDiagnostics: 'tab',
  pauseReachabilityProbeHost: 'tab',
  pauseReachabilityProbeMode: 'tab',
  pauseReachabilityProbeIntervalSec: 'tab',
  pauseAllowPrivateRanges: 'tab',
  mcpCleanupBackupsOnQuit: 'tab',
  mcpDisableProviderBackups: 'tab',
  mcpAllowWorldWritableParent: 'tab',
  graphClientId: 'tab',
  graphAuthority: 'tab',
  graphScopesJson: 'tab',
  graphAgentWritableAccountsJson: 'tab',
  rtkEnabled: 'tab',
  rtkBundledOnly: 'tab',
  notifyOnAgentCompletion: 'tab',
  notifyOnLoopTerminal: 'tab',
  notificationSoundMode: 'tab',
  // Written by dismissing a hint, never edited directly.
  dismissedHints: 'internal',
  notificationCooldownSeconds: 'tab',
  notificationQuietHoursEnabled: 'tab',
  notificationQuietHoursStartHour: 'tab',
  notificationQuietHoursEndHour: 'tab',
  channelToolHeartbeat: 'tab',
  cliUpdatePolicy: 'tab',
  injectRepoMap: 'internal',
  repoMapTokenBudget: 'internal',
  detectDegradedAdapterOutput: 'internal',
  // Two real controls: the Overnight profile row (`OVERNIGHT_PROFILE.values`)
  // and the notification-centre "Turn on auto-interrupt" action (N2).
  toolLoopAutoInterrupt: 'bespoke',
  approvalAdjudicationEnabled: 'internal',
  enableSpawnWorkerOffload: 'internal',
  projectPluginTrust: 'internal',
  // A checkbox on the source-control panel, which is not a settings tab —
  // `source-control-repo-actions.component.ts` `onTogglePrCreation`.
  allowPrCreation: 'bespoke',
  auxiliaryLlmEnabled: 'bespoke', // auxiliary-models tab
  auxiliaryLlmRoutingMode: 'bespoke', // auxiliary-models tab
  auxiliaryLlmAllowRemoteWorkerModels: 'internal',
  auxiliaryLlmUseLocalhostOllama: 'bespoke', // auxiliary-models tab
  auxiliaryLlmDailySpendCapUsd: 'bespoke', // auxiliary-models tab
  auxiliaryLlmEndpointsJson: 'internal',
  auxiliaryLlmSlotsJson: 'bespoke', // auxiliary-models tab
  auxiliaryLlmQuickModel: 'bespoke', // auxiliary-models tab
  auxiliaryLlmQualityModel: 'bespoke', // auxiliary-models tab
  auxiliaryLlmRoutingClassificationEnabled: 'bespoke', // auxiliary-models tab
  localAiGuardDefaultFallbackPolicy: 'tab',
  localAiGuardDailyFallbackBudgetUsd: 'tab',
  localAiGuardConfirmAboveInputTokens: 'tab',
  // S4.2: was 'internal' because it had no UI at all. Now rendered by the
  // routing-matrix table on the Orchestration tab, which selects it by name.
  orchestrationRoutingPolicyJson: 'bespoke',
  reactionsEnabled: 'tab',
  reactionsPollIntervalMs: 'tab',
  transcriptVirtualization: 'internal',
  progressNoteDisplay: 'tab',

  // Inherited from `DesktopComputerUseSettings` rather than declared in the
  // `AppSettings` body — which is exactly why the first generated version of
  // this file missed them and the `satisfies` check caught it. All six are
  // owned by the dedicated Computer Use tab (S1.5).
  computerUseEnabled: 'bespoke',
  computerUseAllowedAppsJson: 'bespoke',
  computerUseDeniedAppsJson: 'bespoke',
  computerUseRequireApprovalForInput: 'bespoke',
  computerUseStoreScreenshotsForEscalations: 'bespoke',
  computerUseAutonomyLevel: 'bespoke',
} as const satisfies Record<keyof AppSettings, SettingSurfacing>;

/** Keys with no settings-UI presence at all. */
export function internalSettingKeys(): (keyof AppSettings)[] {
  return (Object.keys(SETTING_SURFACING) as (keyof AppSettings)[])
    .filter((key) => SETTING_SURFACING[key] === 'internal');
}
