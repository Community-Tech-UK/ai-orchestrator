import { z } from 'zod';
import {
  DEFAULT_SETTINGS,
  SETTINGS_METADATA,
  type AppSettings,
} from '../../../shared/types/settings.types';
import type {
  AuxiliaryLlmProvider,
  AuxiliaryLlmSlot,
} from '../../../shared/types/auxiliary-llm.types';

export type SettingsToolPolicyTier = 'open' | 'read-only' | 'secret';

export interface OpenSettingsToolPolicy {
  tier: 'open';
  restartRequired: boolean;
  schema: z.ZodType<unknown>;
}

export interface ClosedSettingsToolPolicy {
  tier: 'read-only' | 'secret';
  restartRequired: boolean;
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
const metadataByKey = new Map(SETTINGS_METADATA.map((metadata) => [metadata.key, metadata]));

const cliSchema = z.enum(['auto', 'claude', 'gemini', 'antigravity', 'codex', 'copilot', 'cursor', 'openai']);
const themeSchema = z.enum(['dark', 'light', 'system']);
const displayDensitySchema = z.enum(['comfortable', 'compact']);
const sidebarStyleSchema = z.enum(['standard', 'compact']);
const missedRunPolicySchema = z.enum(['skip', 'notify', 'runOnce']);
const outputStyleSchema = z.enum(['default', 'explanatory', 'learning', 'concise']);
const reviewDepthSchema = z.enum(['structured', 'tiered']);
const reviewProviderSchema = z.enum(['gemini', 'antigravity', 'codex', 'copilot', 'claude', 'cursor']);
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
  loopScoring: auxiliarySlotSchema.optional(),
  retrievalHypothesis: auxiliarySlotSchema.optional(),
  branchScoring: auxiliarySlotSchema.optional(),
  subQueryExecution: auxiliarySlotSchema.optional(),
  verifyOutputSummary: auxiliarySlotSchema.optional(),
} satisfies Record<AuxiliaryLlmSlot, z.ZodOptional<typeof auxiliarySlotSchema>>).strict();
const auxiliarySlotPayloadSchema = jsonBackedObjectSchema(auxiliarySlotMapSchema);

const open = (
  schema: z.ZodType<unknown>,
  restartRequired = false,
): OpenSettingsToolPolicy => ({
  tier: 'open',
  restartRequired,
  schema,
});
const readOnly = (restartRequired = false): ClosedSettingsToolPolicy => ({
  tier: 'read-only',
  restartRequired,
});
const secret = (restartRequired = false): ClosedSettingsToolPolicy => ({
  tier: 'secret',
  restartRequired,
});

export const SETTINGS_TOOL_POLICY = {
  defaultYoloMode: readOnly(),
  defaultWorkingDirectory: open(settingStringSchema),
  defaultCli: open(cliSchema),
  defaultModel: open(modelIdSchema),
  defaultModelByProvider: open(modelByProviderSchema),
  defaultFastMode: open(z.boolean()),
  defaultFastModeByProvider: open(fastModeByProviderSchema),
  residentClaudeSession: readOnly(),
  theme: open(themeSchema),
  maxChildrenPerParent: open(numberSettingSchema('maxChildrenPerParent')),
  maxTotalInstances: open(numberSettingSchema('maxTotalInstances')),
  autoTerminateIdleMinutes: open(numberSettingSchema('autoTerminateIdleMinutes')),
  allowNestedOrchestration: readOnly(),
  maxSpawnDepth: readOnly(),
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
  customModelOverride: open(modelIdSchema),
  customModelsByProvider: open(customModelsByProviderSchema),
  modelCatalogRemoteOverrideUrl: open(optionalHttpUrlSchema),
  parserBufferMaxKB: open(numberSettingSchema('parserBufferMaxKB')),
  codememEnabled: open(z.boolean()),
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
  // Agents must never repoint or read the vault master-password source.
  browserVaultMasterPasswordFile: secret(),
  codebaseAutoIndexEnabled: open(z.boolean()),
  instanceProviderLimitResumeEnabled: open(z.boolean()),
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
  crossModelReviewProviders: open(z.array(reviewProviderSchema).max(5)),
  crossModelReviewTimeout: open(numberSettingSchema('crossModelReviewTimeout')),
  crossModelReviewTypes: open(z.array(reviewTypeSchema).max(3)),
  crossModelReviewModelByProvider: open(modelByProviderSchema),
  pingPongReviewerProvider: open(
    z.enum(['auto', 'gemini', 'antigravity', 'codex', 'copilot', 'claude', 'cursor']),
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
  rtkEnabled: open(z.boolean(), true),
  rtkBundledOnly: open(z.boolean(), true),
  notifyOnAgentCompletion: open(z.boolean()),
  cliUpdatePolicy: open(cliUpdatePolicySchema),
  injectRepoMap: open(z.boolean()),
  repoMapTokenBudget: open(z.number().finite().int().min(0).max(200_000)),
  detectDegradedAdapterOutput: open(z.boolean()),
  enableSpawnWorkerOffload: open(z.boolean(), true),
  projectPluginTrust: readOnly(),
  auxiliaryLlmEnabled: open(z.boolean()),
  auxiliaryLlmRoutingMode: open(auxiliaryRoutingModeSchema),
  auxiliaryLlmAllowRemoteWorkerModels: open(z.boolean()),
  auxiliaryLlmUseLocalhostOllama: open(z.boolean()),
  auxiliaryLlmEndpointsJson: secret(),
  auxiliaryLlmSlotsJson: open(auxiliarySlotPayloadSchema),
  auxiliaryLlmQuickModel: open(modelIdSchema),
  auxiliaryLlmQualityModel: open(modelIdSchema),
  auxiliaryLlmRoutingClassificationEnabled: open(z.boolean()),

  // Reactions (event-driven re-prompting)
  reactionsEnabled: open(z.boolean()),
  reactionsPollIntervalMs: open(z.number().int().min(5000).max(600_000)),
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
  const expected = typeof DEFAULT_SETTINGS[typedKey];
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
