import { z } from 'zod';
import {
  DEFAULT_SETTINGS,
  SETTINGS_METADATA,
  type AppSettings,
  type OrchestrationRoutingPolicyKey,
} from '../../../shared/types/settings.types';
import type {
  AuxiliaryLlmProvider,
  AuxiliaryLlmSlot,
} from '../../../shared/types/auxiliary-llm.types';
import { COMPUTER_USE_AUTONOMY_LEVELS } from '../../../shared/types/desktop-gateway-settings.types';
import { REMOTE_REVIEWER_PROVIDER_IDS } from '../../../shared/types/reviewer-provider.types';
import { AUTOMATION_PROVIDER_IDS } from '../../../shared/types/automation-provider.types';
import {
  CopilotAccountProfilesSchema,
  CopilotAccountRoutingRulesSchema,
} from '@contracts/schemas/copilot-account';

export type SettingsToolPolicyTier = 'open' | 'read-only' | 'secret';

export interface OpenSettingsToolPolicy {
  tier: 'open';
  restartRequired: boolean;
  schema: z.ZodType<unknown>;
}

export interface ClosedSettingsToolPolicy {
  tier: 'read-only' | 'secret';
  restartRequired: boolean;
  schema?: z.ZodType<unknown>;
}

export type SettingsToolPolicy = OpenSettingsToolPolicy | ClosedSettingsToolPolicy;

export interface CoercedWritableSetting<K extends keyof AppSettings = keyof AppSettings> {
  key: K;
  value: AppSettings[K];
  policy: OpenSettingsToolPolicy;
}

const READ_ONLY_POLICY: ClosedSettingsToolPolicy = {
  tier: 'read-only',
  restartRequired: false,
};
const SECRET_POLICY: ClosedSettingsToolPolicy = {
  tier: 'secret',
  restartRequired: false,
};
const SECRET_KEY_PATTERN = /token|secret|key|cert|password/i;
const REDACTED = '[redacted]';
const PRIVILEGED_CLI_OPERATOR_ONLY_KEYS = new Set<keyof AppSettings>([
  // 2026-08-29 DELIBERATE WIDENING, authorised by the operator in session.
  //
  // `browserVaultMasterPasswordFile`, `browserVaultAutoUnlock` and
  // `browserAllowSharedTabCredentialFill` were removed from this set and are
  // now writable through the privileged `aio-mcp settings` CLI. They were the
  // whole of what stood between an agent and an unattended portal login: every
  // stalled task in this class was an authentication step, never an approval
  // step.
  //
  // NOT widened: the safe `set_setting` MCP tool (all three stay closed-tier
  // below); approval to send anything a human contact sees; the other anchors.
  //
  // Writes emit a `privileged_set` / `privileged_reset` record via
  // `logSettingMutation`. That is a `logger.info` line, not a tamper-evident
  // audit trail: enough for "what changed and when", not for "did something try
  // to hide this". The compensating visible control is the standing warning on
  // the Browser screen's vault card, fed by `sharedTabCredentialFillEnabled` on
  // `BrowserVaultStatus`.
  // WS-B1 phase 1 (2026-07-31 fresh-eyes CRITICAL fix): PR creation authority
  // is a human/GUI-only decision — the privileged repair CLI's agent-facing
  // `settings set` path must not be able to grant it either.
  'allowPrCreation',
  // 2026-08-19 fresh-eyes finding: a licence guardrail (e.g. keeping a
  // work-only Copilot seat out of automatic selection) is worthless if the
  // very agents it restricts can clear it through the privileged repair CLI.
  // `readOnly()` alone only blocks the safe `set_setting` MCP tool, not this
  // surface — same reasoning as `allowPrCreation` above.
  'providersExcludedFromAutomation',
  // Copilot account routing (2026-08-25). Same class of authority as the
  // exclusion list above, one step further: these decide WHICH GitHub identity
  // services a repository. An agent that could add a profile, move the default,
  // weaken a protected scope, or relax an automation policy could route
  // enterprise code through a personal seat — the exact mistake the feature
  // exists to prevent. Human/GUI-only, on both the safe tool and repair-CLI
  // surfaces.
  'copilotAccountProfiles',
  'copilotAccountRoutingRules',
  'computerUseEnabled',
  'computerUseAllowedAppsJson',
  'computerUseDeniedAppsJson',
  'workspaceSecretsEnabled',
  'workspaceSecretsAllowAgentRequests',
  'computerUseRequireApprovalForInput',
  'computerUseStoreScreenshotsForEscalations',
  'computerUseAutonomyLevel',
  'contextEvidenceModeByProvider',
  'graphClientId',
  'graphAuthority',
  'graphScopesJson',
  'graphAgentWritableAccountsJson',
  'localAiGuardDefaultFallbackPolicy',
  'localAiGuardDailyFallbackBudgetUsd',
  'localAiGuardConfirmAboveInputTokens',
]);
const metadataByKey = new Map(SETTINGS_METADATA.map((metadata) => [metadata.key, metadata]));

const cliSchema = z.enum(['auto', 'claude', 'gemini', 'antigravity', 'codex', 'copilot', 'cursor', 'grok', 'openai']);
const themeSchema = z.enum(['dark', 'light', 'system']);
const displayDensitySchema = z.enum(['comfortable', 'compact']);
const sidebarStyleSchema = z.enum(['standard', 'compact']);
const missedRunPolicySchema = z.enum(['skip', 'notify', 'runOnce']);
const outputStyleSchema = z.enum(['default', 'explanatory', 'learning', 'concise']);
const reviewDepthSchema = z.enum(['structured', 'tiered']);
const reviewProviderSchema = z.enum(REMOTE_REVIEWER_PROVIDER_IDS);
const reviewTypeSchema = z.enum(['code', 'plan', 'architecture']);
const cliUpdatePolicySchema = z.enum(['off', 'notify', 'auto']);
const voiceSttRoutingModeSchema = z.enum([
  'auto',
  'this-device',
  'worker-node',
  'cloud',
  'this-device-or-cloud',
]);
const auxiliaryRoutingModeSchema = z.enum(['off', 'local-first', 'cheap-first', 'manual-only']);
const localAiFallbackPolicySchema = z.enum([
  'allow-silently',
  'notify-and-allow',
  'require-confirmation',
  'defer-locally',
  'block-paid-fallback',
]);
const auxiliaryProviderSchema = z.enum([
  'ollama',
  'openai-compatible',
  'anthropic',
  'openai',
  'local-fallback',
  'auto',
] satisfies (AuxiliaryLlmProvider | 'auto')[]);
const modelIdSchema = z.string().max(512);
const customModelIdSchema = z.string().trim().min(1).max(512);
const shortStringSchema = z.string().min(1).max(128);
const settingStringSchema = z.string().max(4096);
const optionalUrlSchema = z.union([z.literal(''), z.string().url().max(4096)]);
const optionalHttpUrlSchema = z.union([
  z.literal(''),
  z.string().url().max(4096).regex(/^https?:\/\//i, 'Must be an HTTP(S) URL'),
]);
const optionalEnvNameSchema = z.union([
  z.literal(''),
  z.string().max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
]);
const modelByProviderSchema = z.record(shortStringSchema, modelIdSchema);
const customModelsByProviderSchema = z.record(
  shortStringSchema,
  z.array(customModelIdSchema).max(200),
);
const fastModeByProviderSchema = z.record(shortStringSchema, z.boolean());
const modelUsageEntrySchema = z.object({
  count: z.number().finite().int().min(1).max(1_000_000),
  lastUsedAt: z.number().finite().int().min(0),
}).strict();
// Keys are `provider:modelId`; local-model selector ids can be long.
const modelUsageKeySchema = z.string().min(1).max(768);
const modelUsageByKeySchema = z.record(modelUsageKeySchema, modelUsageEntrySchema);
const auxiliarySlotSchema = z.object({
  enabled: z.boolean(),
  provider: auxiliaryProviderSchema.optional(),
  endpointId: shortStringSchema.optional(),
  model: modelIdSchema.refine((value) => value.length > 0, {
    message: 'String must contain at least 1 character(s)',
  }).optional(),
  tier: z.enum(['quick', 'quality']).optional(),
  maxInputTokens: z.number().finite().int().min(1).max(1_000_000),
  maxOutputTokens: z.number().finite().int().min(1).max(1_000_000),
  temperature: z.number().finite().min(0).max(2),
  timeoutMs: z.number().finite().int().min(1).max(600_000),
  requireJson: z.boolean(),
  allowFrontierFallback: z.boolean(),
}).strict();
const auxiliarySlotMapSchema = z.object({
  compression: auxiliarySlotSchema.optional(),
  memoryDistillation: auxiliarySlotSchema.optional(),
  webExtract: auxiliarySlotSchema.optional(),
  titleGeneration: auxiliarySlotSchema.optional(),
  routingClassification: auxiliarySlotSchema.optional(),
  approvalScoring: auxiliarySlotSchema.optional(),
  approvalAdjudication: auxiliarySlotSchema.optional(),
  loopScoring: auxiliarySlotSchema.optional(),
  retrievalHypothesis: auxiliarySlotSchema.optional(),
  branchScoring: auxiliarySlotSchema.optional(),
  subQueryExecution: auxiliarySlotSchema.optional(),
  verifyOutputSummary: auxiliarySlotSchema.optional(),
} satisfies Record<AuxiliaryLlmSlot, z.ZodOptional<typeof auxiliarySlotSchema>>).strict();
const auxiliarySlotPayloadSchema = jsonBackedObjectSchema(auxiliarySlotMapSchema);

// Operator routing policy: which model tier each orchestration gate uses.
// `.strict()` so an unknown gate name is rejected loudly rather than silently
// ignored — a typo'd key would otherwise leave that gate on its default and
// look like the setting simply didn't work.
const orchestrationRoutingPolicyValueSchema = z.enum(['auto', 'fast', 'balanced', 'powerful']);
const orchestrationRoutingPolicyMapSchema = z.object({
  loop: orchestrationRoutingPolicyValueSchema.optional(),
  workflow: orchestrationRoutingPolicyValueSchema.optional(),
  verify: orchestrationRoutingPolicyValueSchema.optional(),
  review: orchestrationRoutingPolicyValueSchema.optional(),
  debate: orchestrationRoutingPolicyValueSchema.optional(),
  debateSynthesis: orchestrationRoutingPolicyValueSchema.optional(),
} satisfies Record<
  OrchestrationRoutingPolicyKey,
  z.ZodOptional<typeof orchestrationRoutingPolicyValueSchema>
>).strict();
const orchestrationRoutingPolicySchema = jsonBackedObjectSchema(orchestrationRoutingPolicyMapSchema);

// Closed-tier, Record-valued settings without an explicit schema were the
// exact CRITICAL gap found in the WS-B1 phase 1 fresh-eyes review (2026-07-31):
// `coerceRendererSettingValue`'s typeof-fallback treats `typeof value ===
// 'object'` as sufficient, which matches ANY object/array shape and provides
// no structural validation. A full survey of every closed-tier key (see the
// hardened fallback in `coerceRendererSettingValue` below) found exactly
// three Record-typed settings relying on that fallback; all three now get a
// real schema so a malformed/oversized payload is rejected at the write
// boundary instead of merely being sanitized downstream.
const contextEvidenceModeSchema = z.enum(['off', 'shadow', 'enforce']);
const contextEvidenceModeByProviderSchema = z.record(z.string().min(1).max(64), contextEvidenceModeSchema);
const projectPluginTrustValueSchema = z.enum(['trusted', 'untrusted', 'ask']);
const projectPluginTrustMapSchema = z.record(z.string().min(1).max(1000), projectPluginTrustValueSchema);
// WS-B1 phase 1 — per-project PR-creation opt-in map.
const allowPrCreationMapSchema = z.record(z.string().min(1).max(1000), z.boolean());

// WS-C9 — user keybinding overrides, serialized by
// `serializeKeybindingCustomizations` (renderer `keybinding-conflicts.ts`).
const keybindingModifierSchema = z.enum(['ctrl', 'alt', 'shift', 'meta', 'cmd']);
const keybindingComboSchema = z.object({
  key: z.string().min(1).max(32),
  modifiers: z.array(keybindingModifierSchema).max(4),
}).strict();
const keybindingCustomizationSchema = z.object({
  id: z.string().min(1).max(128),
  keys: z.union([keybindingComboSchema, z.array(keybindingComboSchema).max(6)]),
}).strict();
const keybindingCustomizationsMapSchema = z.object({
  version: z.literal(1).optional(),
  customizations: z.array(keybindingCustomizationSchema).max(200),
}).strict();
// `''` is this setting's own default sentinel for "no overrides" (see
// DEFAULT_SETTINGS.keybindingCustomizations and the `if (!raw) return;`
// guard in KeybindingService's load path) — unlike `jsonBackedObjectSchema`'s
// other two callers below, which default to a real JSON string
// (DEFAULT_ORCHESTRATION_ROUTING_POLICY_JSON / a stringified slot map) and
// must keep rejecting a genuinely empty string. Scoped to this call site
// only, not added to `jsonBackedObjectSchema` itself, so those other two
// settings are unaffected.
const keybindingCustomizationsSchema = z.union([
  z.literal(''),
  jsonBackedObjectSchema(keybindingCustomizationsMapSchema),
]);

const workerModeSchema = z.object({
  role: z.enum(['unset', 'coordinator', 'worker']),
  startWorkerOnLaunch: z.boolean(),
  installWorkerService: z.boolean(),
  lastCoordinatorName: z.string().max(255).optional(),
  lastCoordinatorUrl: z.string().max(2048).optional(),
}).strict();

const open = (
  schema: z.ZodType<unknown>,
  restartRequired = false,
): OpenSettingsToolPolicy => ({
  tier: 'open',
  restartRequired,
  schema,
});
const readOnly = (
  restartRequired = false,
  schema?: z.ZodType<unknown>,
): ClosedSettingsToolPolicy => ({
  tier: 'read-only',
  restartRequired,
  ...(schema ? { schema } : {}),
});
const secret = (restartRequired = false): ClosedSettingsToolPolicy => ({
  tier: 'secret',
  restartRequired,
});

// Maintenance rule: every new AppSettings key must be classified here when it
// is added. This object is the canonical CLI settings exposure policy for both
// safe MCP tools and the privileged `aio-mcp settings` repair surface.
export const SETTINGS_TOOL_POLICY = {
  defaultYoloMode: readOnly(),
  defaultWorkingDirectory: open(settingStringSchema),
  defaultCli: open(cliSchema),
  defaultModel: open(modelIdSchema),
  defaultModelByProvider: open(modelByProviderSchema),
  automationDefaultCli: open(cliSchema),
  automationDefaultModel: open(modelIdSchema),
  defaultFastMode: open(z.boolean()),
  defaultFastModeByProvider: open(fastModeByProviderSchema),
  modelUsageByKey: open(modelUsageByKeySchema),
  modelPickerFavorites: open(z.array(z.string().min(1).max(768)).max(50)),
  residentClaudeSession: readOnly(),
  // Rollout posture is a trusted operator decision. Agents may inspect it but
  // cannot silently advance a provider from off/shadow to enforce mid-run.
  // Schema-gated (2026-07-31 hardening) even though `normalizeContextEvidenceModeByProvider`
  // already sanitizes malformed values downstream — belt and suspenders at
  // the write boundary too.
  contextEvidenceModeByProvider: readOnly(false, contextEvidenceModeByProviderSchema),
  theme: open(themeSchema),
  maxChildrenPerParent: open(numberSettingSchema('maxChildrenPerParent')),
  maxTotalInstances: open(numberSettingSchema('maxTotalInstances')),
  autoTerminateIdleMinutes: open(numberSettingSchema('autoTerminateIdleMinutes')),
  allowNestedOrchestration: readOnly(),
  maxSpawnDepth: readOnly(),
  docReviewResumeOnSubmit: readOnly(),
  defaultMissedRunPolicy: open(missedRunPolicySchema),
  outputBufferSize: open(numberSettingSchema('outputBufferSize')),
  enableDiskStorage: open(z.boolean()),
  maxDiskStorageMB: open(numberSettingSchema('maxDiskStorageMB')),
  memoryWarningThresholdMB: open(numberSettingSchema('memoryWarningThresholdMB')),
  autoTerminateOnMemoryPressure: open(z.boolean()),
  persistSessionContent: open(z.boolean()),
  cumulativeTokenCompactionTrigger: open(numberSettingSchema('cumulativeTokenCompactionTrigger')),
  outputStyle: open(outputStyleSchema),
  fontSize: open(numberSettingSchema('fontSize')),
  displayDensity: open(displayDensitySchema),
  sidebarStyle: open(sidebarStyleSchema),
  contextWarningThreshold: open(numberSettingSchema('contextWarningThreshold')),
  showToolMessages: open(z.boolean()),
  showThinking: open(z.boolean()),
  thinkingDefaultExpanded: open(z.boolean()),
  showCost: open(z.boolean()),
  maxRecentDirectories: open(numberSettingSchema('maxRecentDirectories')),
  keybindingCustomizations: open(keybindingCustomizationsSchema),
  customModelOverride: open(modelIdSchema),
  customModelsByProvider: open(customModelsByProviderSchema),
  modelCatalogRemoteOverrideUrl: open(optionalHttpUrlSchema),
  parserBufferMaxKB: open(numberSettingSchema('parserBufferMaxKB')),
  codememEnabled: open(z.boolean()),
  loopSurfaceCodemem: open(z.boolean()),
  loopSurfaceLessons: open(z.boolean()),
  codememIndexingEnabled: open(z.boolean()),
  codememLspWorkerEnabled: open(z.boolean(), true),
  codememPrewarmEnabled: open(z.boolean()),
  codememPrewarmMaxConcurrent: open(numberSettingSchema('codememPrewarmMaxConcurrent')),
  codememPrewarmDebounceMs: open(numberSettingSchema('codememPrewarmDebounceMs')),
  codememPrewarmStartupHint: open(z.boolean()),
  commandDiagnosticsAvailable: open(z.boolean()),
  broadRootFileThreshold: open(numberSettingSchema('broadRootFileThreshold')),
  chromeDevtoolsAttachEnabled: readOnly(true),
  chromeDevtoolsAttachProfileId: readOnly(true),
  // Authorization anchors for credential-vault unlock. NOT agent-writable — a
  // tool-call must never repoint the master-password source or enable
  // hands-free unlock (this tree runs many autonomous agents). The local
  // operator sets these from the UI/preferences, or via the operator-owned
  // AIO_BW_MASTER_PASSWORD_FILE launch env var. The path is redacted + excluded
  // from settings export; the password itself is never stored here or logged.
  browserVaultMasterPasswordFile: secret(),
  browserVaultAutoUnlock: readOnly(),
  // WS11.2: routes page text through the aux model; operator decides.
  browserAuxExtractionEnabled: readOnly(),
  // WS9: global tool-surface economy; an agent must not re-inflate every
  // future session's schema tax (or shrink another session's surface) via a
  // tool call — the operator decides.
  browserMcpToolDeferral: readOnly(),
  // Spec item 5: changes what context reaches providers on swap/restore.
  sessionHandoffStateEnabled: open(z.boolean()),
  // WS16: provenance gate for instruction-tier memory (readOnly — safety default).
  memoryInstructionGate: readOnly(),
  // WS14: overload fallback model for Claude sessions (empty = off).
  claudeFallbackModel: open(z.string().max(100)),
  // WS14: env scrub can break hook/RTK env passthrough — operator-only.
  claudeSubprocessEnvScrub: readOnly(),
  // WS7 Phase B: the operator's fallback-provider list is the failover consent
  // surface. Open so it is configurable, bounded to the known loop providers.
  sessionFailoverProviders: open(
    z.array(z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok'])).max(7),
  ),
  sessionFailoverMaxSwitches: open(numberSettingSchema('sessionFailoverMaxSwitches')),
  sessionFailoverOfferAfterMinutes: open(numberSettingSchema('sessionFailoverOfferAfterMinutes')),
  // WS12: a prompt-injected agent must never soften the instruction trust
  // gate; only the operator changes the mode.
  instructionTrustGate: readOnly(),
  // Security-sensitive: authorizes autonomous credential fills on the user's
  // real shared browser. Still closed to the safe settings tool, but since
  // 2026-08-29 an agent CAN enable it through the privileged repair CLI (see
  // the widening note on PRIVILEGED_CLI_OPERATOR_ONLY_KEYS). Compensating
  // control: the standing warning on the Browser screen's vault card.
  browserAllowSharedTabCredentialFill: readOnly(),
  workspaceSecretsEnabled: readOnly(),
  workspaceSecretsAllowAgentRequests: readOnly(),
  codebaseAutoIndexEnabled: open(z.boolean()),
  instanceProviderLimitResumeEnabled: open(z.boolean()),
  loopAllowProviderOverage: open(z.boolean()),
  codebaseAutoIndexMaxFiles: open(numberSettingSchema('codebaseAutoIndexMaxFiles')),
  codebaseAutoIndexMaxBytes: open(numberSettingSchema('codebaseAutoIndexMaxBytes')),
  codebaseAutoIndexConcurrent: open(numberSettingSchema('codebaseAutoIndexConcurrent')),
  codebaseAutoIndexDebounceMs: open(numberSettingSchema('codebaseAutoIndexDebounceMs')),
  codebaseAutoIndexStartupHint: open(z.boolean()),
  projectKnowledgeAutoMirrorEnabled: open(z.boolean()),
  projectKnowledgeAutoMirrorDebounceMs: open(
    numberSettingSchema('projectKnowledgeAutoMirrorDebounceMs'),
  ),
  projectKnowledgeAutoMirrorMaxConcurrent: open(
    numberSettingSchema('projectKnowledgeAutoMirrorMaxConcurrent'),
  ),
  projectKnowledgeAutoMirrorSkipWithinMs: open(
    numberSettingSchema('projectKnowledgeAutoMirrorSkipWithinMs'),
  ),
  projectKnowledgeAutoMirrorStartupHint: open(z.boolean()),
  crossModelReviewEnabled: open(z.boolean()),
  crossModelReviewDepth: open(reviewDepthSchema),
  crossModelReviewMaxReviewers: open(numberSettingSchema('crossModelReviewMaxReviewers')),
  crossModelReviewProviders: open(z.array(reviewProviderSchema).max(6)),
  crossModelReviewTimeout: open(numberSettingSchema('crossModelReviewTimeout')),
  crossModelReviewTypes: open(z.array(reviewTypeSchema).max(3)),
  crossModelReviewModelByProvider: open(modelByProviderSchema),
  loopModelByProvider: open(modelByProviderSchema),
  crossModelReviewLocalEnabled: open(z.boolean()),
  crossModelReviewLocalSelectorId: open(settingStringSchema),
  crossModelReviewLocalTimeout: open(z.number().finite().int().min(10).max(600)),
  crossModelReviewLocalMaxToolRounds: open(z.number().finite().int().min(1).max(32)),
  // Licence guardrail: this list is what stops an automatic path from calling a
  // provider the operator may only use in a specific context (e.g. a work-only
  // Copilot seat). An agent that could edit it could grant itself the very
  // access the operator withheld, so it is operator-only. (This used to argue
  // by analogy to browserAllowSharedTabCredentialFill, which stopped being an
  // anchor on 2026-08-29; the reasoning stands on its own.)
  providersExcludedFromAutomation: readOnly(
    false,
    z.array(z.enum(AUTOMATION_PROVIDER_IDS)).max(AUTOMATION_PROVIDER_IDS.length),
  ),
  // Copilot account routing. Read-only to the safe tool surface AND listed in
  // PRIVILEGED_CLI_OPERATOR_ONLY_KEYS above, because `readOnly()` alone still
  // leaves the privileged repair CLI able to write — same precedent as
  // providersExcludedFromAutomation. The explicit schema also keeps these
  // array-of-object settings off `coerceRendererSettingValue`'s primitive-only
  // fallback, which refuses non-primitive closed-tier keys outright.
  copilotAccountProfiles: readOnly(false, CopilotAccountProfilesSchema),
  copilotAccountRoutingRules: readOnly(false, CopilotAccountRoutingRulesSchema),
  pingPongReviewerProvider: open(
    z.enum(['auto', ...REMOTE_REVIEWER_PROVIDER_IDS]),
  ),
  pingPongMaxRounds: open(z.number().int().min(1).max(20)),
  voiceSttRoutingMode: open(voiceSttRoutingModeSchema),
  voiceLocalSttEnabled: open(z.boolean()),
  voiceLocalSttWorkerNodeId: open(z.string().max(128)),
  voiceLocalSttModel: open(modelIdSchema),
  voiceLocalSttLanguage: open(z.string().trim().min(2).max(16)),
  voiceThisDeviceSttEndpointUrl: open(optionalUrlSchema),
  voiceThisDeviceSttApiKeyEnv: open(optionalEnvNameSchema),
  voiceLocalSttMaxSegmentMs: open(z.number().finite().int().min(500).max(60_000)),
  remoteNodesEnabled: readOnly(true),
  workerMode: open(workerModeSchema, true),
  remoteNodesServerPort: readOnly(true),
  remoteNodesServerHost: readOnly(true),
  remoteNodesEnrollmentToken: secret(),
  remoteNodesAutoOffloadBrowser: open(z.boolean()),
  remoteNodesAutoOffloadAndroid: open(z.boolean()),
  remoteNodesAutoOffloadGpu: open(z.boolean()),
  remoteNodesNamespace: readOnly(true),
  remoteNodesRequireTls: readOnly(true),
  remoteNodesTlsMode: readOnly(true),
  remoteNodesTlsCertPath: secret(true),
  remoteNodesTlsKeyPath: secret(true),
  remoteNodesRegisteredNodes: secret(),
  thinClientWsEnabled: readOnly(true),
  thinClientWsHost: readOnly(true),
  thinClientWsPort: readOnly(true),
  mobileGatewayEnabled: readOnly(true),
  mobileGatewayPort: readOnly(true),
  mobileGatewayBindInterface: readOnly(true),
  mobileGatewayDevices: secret(),
  mobileGatewayTlsCertPath: secret(true),
  mobileGatewayTlsKeyPath: secret(true),
  mobileGatewayApnsKeyP8: secret(true),
  mobileGatewayApnsKeyId: secret(true),
  mobileGatewayApnsTeamId: secret(true),
  mobileGatewayApnsBundleId: readOnly(true),
  mobileGatewayApnsProduction: readOnly(true),
  pauseFeatureEnabled: readOnly(),
  pauseOnVpnEnabled: readOnly(),
  pauseVpnInterfacePattern: readOnly(),
  pauseTreatExistingVpnAsActive: readOnly(),
  pauseDetectorDiagnostics: readOnly(),
  pauseReachabilityProbeHost: readOnly(),
  pauseReachabilityProbeMode: readOnly(),
  pauseReachabilityProbeIntervalSec: readOnly(),
  pauseAllowPrivateRanges: readOnly(),
  mcpCleanupBackupsOnQuit: open(z.boolean()),
  mcpDisableProviderBackups: readOnly(),
  mcpAllowWorldWritableParent: readOnly(),
  // Identity configuration and the calendar write allowlist are operator-owned.
  // Agents may inspect them through status tools but cannot widen consent or
  // authorize another calendar through the generic settings mutation surface.
  graphClientId: readOnly(true),
  graphAuthority: readOnly(true),
  graphScopesJson: readOnly(true),
  graphAgentWritableAccountsJson: readOnly(true),
  computerUseEnabled: readOnly(),
  computerUseAllowedAppsJson: readOnly(),
  computerUseDeniedAppsJson: readOnly(),
  computerUseRequireApprovalForInput: readOnly(),
  computerUseStoreScreenshotsForEscalations: readOnly(),
  // Human/GUI-only like every other computerUse* key. An agent that could raise
  // its own autonomy level would make the level meaningless.
  computerUseAutonomyLevel: readOnly(false, z.enum(COMPUTER_USE_AUTONOMY_LEVELS)),
  rtkEnabled: open(z.boolean(), true),
  rtkBundledOnly: open(z.boolean(), true),
  notifyOnAgentCompletion: open(z.boolean()),
  channelToolHeartbeat: open(z.boolean()),
  notificationCooldownSeconds: open(z.number().finite().int().min(0).max(3600)),
  notificationQuietHoursEnabled: open(z.boolean()),
  notificationQuietHoursStartHour: open(z.number().finite().int().min(0).max(23)),
  notificationQuietHoursEndHour: open(z.number().finite().int().min(0).max(23)),
  cliUpdatePolicy: open(cliUpdatePolicySchema),
  injectRepoMap: open(z.boolean()),
  repoMapTokenBudget: open(z.number().finite().int().min(0).max(200_000)),
  detectDegradedAdapterOutput: open(z.boolean()),
  toolLoopAutoInterrupt: open(z.boolean()),
  approvalAdjudicationEnabled: open(z.boolean()),
  enableSpawnWorkerOffload: open(z.boolean(), true),
  // Writes actually happen through dedicated `projectPluginTrustGrant`/
  // `projectPluginTrustRevoke` IPC (plugin-manager.ts), not this generic
  // settings surface, but the schema still gates it defensively (see the
  // Record-valued closed-key note above).
  projectPluginTrust: readOnly(false, projectPluginTrustMapSchema),
  // WS-B1 phase 1: per-project PR-creation opt-in is a human/GUI decision,
  // not an agent-tool-writable setting — mirrors projectPluginTrust. Schema-
  // gated (Record<string,boolean>, no typeof fallback) AND excluded from the
  // privileged `aio-mcp settings` CLI below, so the ONLY write path is the
  // renderer Settings-UI IPC a human drives — never an agent/MCP tool call,
  // never the privileged repair CLI.
  allowPrCreation: readOnly(false, allowPrCreationMapSchema),
  auxiliaryLlmEnabled: open(z.boolean()),
  auxiliaryLlmRoutingMode: open(auxiliaryRoutingModeSchema),
  auxiliaryLlmAllowRemoteWorkerModels: open(z.boolean()),
  auxiliaryLlmUseLocalhostOllama: open(z.boolean()),
  auxiliaryLlmDailySpendCapUsd: open(z.number().finite().min(0).nullable()),
  quotaPacingWarningEnabled: open(z.boolean()),
  quotaPacingUtilizationThresholdPercent: open(z.number().finite().min(0).max(100)),
  quotaPacingLatestElapsedPercent: open(z.number().finite().min(0).max(100)),
  auxiliaryLlmEndpointsJson: secret(),
  auxiliaryLlmSlotsJson: open(auxiliarySlotPayloadSchema),
  auxiliaryLlmQuickModel: open(modelIdSchema),
  auxiliaryLlmQualityModel: open(modelIdSchema),
  auxiliaryLlmRoutingClassificationEnabled: open(z.boolean()),
  localAiGuardDefaultFallbackPolicy: readOnly(false, localAiFallbackPolicySchema),
  localAiGuardDailyFallbackBudgetUsd: readOnly(
    false,
    z.number().finite().min(0).max(1_000_000).nullable(),
  ),
  localAiGuardConfirmAboveInputTokens: readOnly(
    false,
    z.number().finite().int().min(0).max(100_000_000).nullable(),
  ),
  // Strictly validated rather than a free-form string: a bad tier name here
  // would silently fall back to the default for that gate, hiding the typo.
  // Agent-writable, consistent with defaultModel / modelUsageByKey, which also
  // steer spend. It cannot escalate privilege — only pick a model tier.
  orchestrationRoutingPolicyJson: open(orchestrationRoutingPolicySchema),

  // Reactions (event-driven re-prompting)
  reactionsEnabled: open(z.boolean()),
  reactionsPollIntervalMs: open(z.number().int().min(5000).max(600_000)),

  // WS-C10 — flagged transcript DOM virtualization prototype (off by default)
  transcriptVirtualization: open(z.boolean()),
} satisfies Record<keyof AppSettings, SettingsToolPolicy>;

export function getSettingsToolPolicy(key: string): SettingsToolPolicy {
  if (hasOwn(SETTINGS_TOOL_POLICY, key)) {
    return SETTINGS_TOOL_POLICY[key as keyof AppSettings];
  }
  return SECRET_KEY_PATTERN.test(key) ? SECRET_POLICY : READ_ONLY_POLICY;
}

export function requireKnownSettingsToolKey(key: string): keyof AppSettings {
  if (!hasOwn(DEFAULT_SETTINGS, key)) {
    throw new Error(`Unknown setting key: ${key}`);
  }
  return key as keyof AppSettings;
}

export function assertReadableSetting(
  key: keyof AppSettings,
  policy: SettingsToolPolicy,
): void {
  if (policy.tier === 'secret') {
    throw new Error(`Cannot read secret setting: ${key}`);
  }
}

export function assertWritableSetting(
  key: keyof AppSettings,
  policy: SettingsToolPolicy,
): asserts policy is OpenSettingsToolPolicy {
  if (policy.tier === 'secret') {
    throw new Error(`Cannot write secret setting: ${key}`);
  }
  if (policy.tier === 'read-only') {
    throw new Error(`Setting is read-only via tools: ${key}`);
  }
}

/**
 * The privileged `aio-mcp settings` CLI is a trusted local repair surface, so
 * its write boundary is NOT the `policyTier` used by the safe MCP tools: it can
 * write every key except the operator-only authorization anchors above. Callers
 * that report writability to a human or an agent must use this, not
 * `policy.tier === 'open'`, or read-only-tier keys look unchangeable when the
 * CLI can in fact change them.
 */
export function isPrivilegedSettingsCliWritable(key: keyof AppSettings): boolean {
  return !PRIVILEGED_CLI_OPERATOR_ONLY_KEYS.has(key);
}

export function assertPrivilegedSettingsCliWritable(key: keyof AppSettings): void {
  if (!isPrivilegedSettingsCliWritable(key)) {
    throw new Error(`Setting is operator-only and cannot be changed by agents: ${key}`);
  }
}

export function coerceWritableSettingValue<K extends keyof AppSettings>(
  key: K,
  value: unknown,
): CoercedWritableSetting<K>;
export function coerceWritableSettingValue(
  key: string,
  value: unknown,
): CoercedWritableSetting;
export function coerceWritableSettingValue(
  key: string,
  value: unknown,
): CoercedWritableSetting {
  const typedKey = requireKnownSettingsToolKey(key);
  const policy = getSettingsToolPolicy(typedKey);
  assertWritableSetting(typedKey, policy);
  return {
    key: typedKey,
    value: parseWritableSettingValue(typedKey, value, policy),
    policy,
  };
}

/**
 * Renderer (IPC) coercion. Policy tiers gate the MCP *tool* surface only —
 * the Settings UI is the trusted human surface and legitimately manages
 * secret-tier keys (enrollment-token regeneration, APNs key upload, TLS
 * paths). The renderer path still rejects unknown keys and malformed values:
 * open keys validate against their full schema; closed keys validate against
 * the persisted value's primitive type with no length caps (the APNs .p8 PEM
 * is multi-KB).
 */
export function coerceRendererSettingValue(
  key: string,
  value: unknown,
): { key: keyof AppSettings; value: AppSettings[keyof AppSettings] } {
  const typedKey = requireKnownSettingsToolKey(key);
  const policy = getSettingsToolPolicy(typedKey);
  if (policy.tier === 'open') {
    return {
      key: typedKey,
      value: parseWritableSettingValue(typedKey, value, policy),
    };
  }
  if (policy.schema) {
    const parsed = policy.schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Invalid value for ${typedKey}: ${formatZodError(parsed.error)}`);
    }
    return {
      key: typedKey,
      value: parsed.data as AppSettings[keyof AppSettings],
    };
  }
  // No explicit schema. 2026-07-31 fresh-eyes CRITICAL fix: a bare
  // `typeof value === typeof persisted` check is only a meaningful gate for
  // primitive types — for an object/array-shaped setting, `typeof value ===
  // 'object'` matches ANY shape (a renderer payload could set a Record-typed
  // closed setting to an arbitrary map and this would previously pass). This
  // is what let `allowPrCreation: {'/repo': true}` through undetected.
  //
  // Every closed-tier key without a schema was surveyed at fix time and is a
  // primitive (string/boolean/number) — the three Record-valued exceptions
  // (`allowPrCreation`, `projectPluginTrust`, `contextEvidenceModeByProvider`)
  // now carry an explicit schema above and never reach this branch. So:
  // reject outright (no fallback at all) for any non-primitive default type,
  // and keep the same-primitive-type check only for the confirmed-safe
  // primitive case. A FUTURE object/array-shaped closed-tier key MUST get an
  // explicit schema — falling through here is a bug, not a feature.
  const expected = typeof DEFAULT_SETTINGS[typedKey];
  if (expected !== 'string' && expected !== 'boolean' && expected !== 'number') {
    throw new Error(
      `Setting ${typedKey} has no writable schema and is not a primitive type; refusing to write it.`,
    );
  }
  if (typeof value !== expected) {
    throw new Error(`Invalid value for ${typedKey}: expected ${expected}`);
  }
  return { key: typedKey, value: value as AppSettings[keyof AppSettings] };
}

export function coerceRendererSettingsUpdate(
  settings: Record<string, unknown>,
): Partial<AppSettings> {
  const coerced: Partial<AppSettings> = {};
  for (const [key, value] of Object.entries(settings)) {
    const writable = coerceRendererSettingValue(key, value);
    (coerced as Record<string, unknown>)[writable.key] = writable.value;
  }
  return coerced;
}

export function settingsValueForTool(
  key: keyof AppSettings,
  rawValue: AppSettings[keyof AppSettings],
  policy: SettingsToolPolicy,
): unknown {
  if (policy.tier === 'secret') {
    return REDACTED;
  }
  if (key === 'auxiliaryLlmSlotsJson' && typeof rawValue === 'string') {
    try {
      return JSON.parse(rawValue) as unknown;
    } catch {
      return { malformedJson: true };
    }
  }
  return rawValue;
}

function parseWritableSettingValue<K extends keyof AppSettings>(
  key: K,
  value: unknown,
  policy: OpenSettingsToolPolicy,
): AppSettings[K] {
  if (value === undefined) {
    throw new Error(`Invalid value for ${String(key)}: undefined is not allowed`);
  }

  const parsed = policy.schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid value for ${String(key)}: ${formatZodError(parsed.error)}`);
  }

  if (key === 'auxiliaryLlmSlotsJson' && typeof parsed.data !== 'string') {
    return JSON.stringify(parsed.data) as AppSettings[K];
  }

  return parsed.data as AppSettings[K];
}

function numberSettingSchema(key: keyof AppSettings): z.ZodNumber {
  const metadata = metadataByKey.get(key);
  let schema = z.number().finite().int();
  if (metadata?.min !== undefined) {
    schema = schema.min(metadata.min);
  }
  if (metadata?.max !== undefined) {
    schema = schema.max(metadata.max);
  }
  return schema;
}

function jsonBackedObjectSchema(schema: z.ZodType<unknown>): z.ZodType<unknown> {
  return z.union([
    z.string().superRefine((value, context) => {
      try {
        const parsed = JSON.parse(value) as unknown;
        const result = schema.safeParse(parsed);
        if (!result.success) {
          for (const issue of result.error.issues) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: issue.path,
              message: issue.message,
            });
          }
        }
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),
    schema,
  ]);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`)
    .join('; ');
}

function hasOwn<T extends object>(object: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(object, key);
}
