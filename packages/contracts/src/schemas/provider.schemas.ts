import { z } from 'zod';
import {
  DirectoryPathSchema,
  FilePathSchema,
  ModelIdSchema,
  RequiredModelIdSchema,
  WorkingDirectorySchema,
} from './common.schemas';

// ============ Provider & Plugin Payloads ============

export const ProviderStatusPayloadSchema = z.object({
  providerType: z.string().min(1).max(50),
  forceRefresh: z.boolean().optional(),
});

/**
 * Sign-in launch request. Only the provider id crosses IPC — the main process
 * maps it to a fixed login command, so no caller string reaches a shell.
 */
export const ProviderRunLoginPayloadSchema = z.object({
  provider: z.string().min(1).max(50),
});

export const ProviderUpdateConfigPayloadSchema = z.object({
  providerType: z.string().min(1).max(50),
  config: z.record(z.string(), z.unknown()),
});

export const PluginsLoadPayloadSchema = z.object({
  idOrPath: z.string().min(1).max(2000),
  timeout: z.number().int().min(0).max(300000).optional(),
  sandbox: z.boolean().optional(),
});

export const PluginsUnloadPayloadSchema = z.object({
  pluginId: z.string().min(1).max(200),
});

export const PluginsInstallPayloadSchema = z.object({
  sourcePath: z.string().min(1).max(2000),
});

export const PluginsUninstallPayloadSchema = z.object({
  pluginId: z.string().min(1).max(200),
});

export const PluginsGetPayloadSchema = z.object({
  pluginId: z.string().min(1).max(200),
});

export const PluginsGetMetaPayloadSchema = z.object({
  pluginId: z.string().min(1).max(200),
});

export const PluginsCreateTemplatePayloadSchema = z.object({
  name: z.string().min(1).max(200),
});

// ============ MCP Payloads ============

export const McpServerPayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
});

export const McpGetServersPayloadSchema = z.object({
  includeExternal: z.boolean().optional(),
}).optional();

export const McpSetServerEnabledPayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
  enabled: z.boolean(),
});

export const McpAddServerPayloadSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  transport: z.enum(['stdio', 'sse', 'http']),
  command: z.string().max(2000).optional(),
  args: z.array(z.string().max(1000)).max(50).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().max(2000).optional(),
  autoConnect: z.boolean().optional(),
});

export const McpCallToolPayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
  toolName: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const McpReadResourcePayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
  uri: z.string().min(1).max(2000),
});

export const McpGetPromptPayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
  promptName: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.string()).optional(),
});

// ============ LLM Payloads ============

export const LLMSummarizePayloadSchema = z.object({
  requestId: z.string().min(1).max(200),
  content: z.string().min(1).max(10000000),
  targetTokens: z.number().int().min(1).max(1000000).optional(),
  preserveKeyPoints: z.boolean().optional(),
});

export const LLMSubQueryPayloadSchema = z.object({
  requestId: z.string().min(1).max(200),
  prompt: z.string().min(1).max(1000000),
  context: z.string().max(1000000).optional().default(''),
  depth: z.number().int().min(0).max(10).optional(),
});

export const LLMCancelStreamPayloadSchema = z.object({
  requestId: z.string().min(1).max(200),
});

export const LLMCountTokensPayloadSchema = z.object({
  text: z.string().max(10000000),
  model: ModelIdSchema.optional(),
});

export const LLMTruncateTokensPayloadSchema = z.object({
  text: z.string().max(10000000),
  maxTokens: z.number().int().min(1).max(1000000),
  model: ModelIdSchema.optional(),
});

export const LLMSetConfigPayloadSchema = z.object({
  anthropicApiKey: z.string().max(500).optional(),
  openaiApiKey: z.string().max(500).optional(),
  model: ModelIdSchema.optional(),
  maxTokens: z.number().int().min(1).max(1000000).optional(),
  temperature: z.number().min(0).max(2).optional(),
}).passthrough();

// ============ CLI Verification Payloads ============

export const CliDetectAllPayloadSchema = z.object({
  force: z.boolean().optional(),
}).optional();

export const CliDetectOnePayloadSchema = z.object({
  command: z.string().min(1).max(200),
});

export const CliTestConnectionPayloadSchema = z.object({
  command: z.string().min(1).max(200),
});

export const CliUpdateOnePayloadSchema = z.object({
  type: z.string().min(1).max(50),
  ipcAuthToken: z.string().optional(),
});

export const CliUpdateAllPayloadSchema = z.object({
  ipcAuthToken: z.string().optional(),
}).optional();

export const ProviderListModelsPayloadSchema = z.object({
  provider: z.string().min(1).max(100),
});

const ProviderModelConfigSchema = z.object({
  type: z.string().trim().min(1).max(128),
  apiKey: z.string().trim().min(1).max(10_000).optional(),
  baseUrl: z.string().trim().min(1).max(2_000).optional(),
  organizationId: z.string().trim().min(1).max(512).optional(),
}).strict();

export const ModelDiscoverPayloadSchema = ProviderModelConfigSchema.optional();

export const ModelGetPayloadSchema = z.object({
  config: ProviderModelConfigSchema.optional(),
  modelId: RequiredModelIdSchema,
}).strict();

export const ModelSelectPayloadSchema = z.object({
  config: ProviderModelConfigSchema.optional(),
  criteria: z.object({
    capabilities: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  }).strict().optional(),
}).strict().optional();

export const ModelProviderStatusPayloadSchema = ProviderModelConfigSchema;

export const ModelVerifyPayloadSchema = z.object({
  config: ProviderModelConfigSchema.optional(),
  modelId: RequiredModelIdSchema,
}).strict();

export const ModelEmptyPayloadSchema = z.undefined().optional();

export const ModelSetOverridePayloadSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  modelId: RequiredModelIdSchema,
  config: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const ModelRemoveOverridePayloadSchema = z.object({
  provider: z.string().trim().min(1).max(128).optional(),
  modelId: RequiredModelIdSchema,
}).strict();

export const CliVerificationStartPayloadSchema = z.object({
  id: z.string().min(1).max(200),
  prompt: z.string().min(1).max(500000),
  context: z.string().max(500000).optional(),
  attachments: z.array(z.object({
    name: z.string().max(500),
    mimeType: z.string().max(100),
    data: z.string().max(50 * 1024 * 1024), // base64 encoded, 50MB limit
  })).max(10).optional(),
  config: z.object({
    cliAgents: z.array(z.string().max(100)).max(20).optional(),
    agentCount: z.number().int().min(1).max(20).optional(),
    synthesisStrategy: z.string().max(50).optional(),
    personalities: z.array(z.string().max(100)).max(20).optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    timeout: z.number().int().min(1000).max(3600000).optional(),
    maxDebateRounds: z.number().int().min(1).max(10).optional(),
    fallbackToApi: z.boolean().optional(),
    mixedMode: z.boolean().optional(),
  }),
});

export const CliVerificationCancelPayloadSchema = z.object({
  id: z.string().min(1).max(200),
});

// ============ Training Payloads ============

export const TrainingGetStrategiesPayloadSchema = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
}).strict().optional();

export const TrainingEmptyPayloadSchema = z.undefined().optional();

export const TrainingConfigPayloadSchema = z.object({
  groupSize: z.number().int().min(1).max(1_000).optional(),
  learningRate: z.number().positive().max(1).optional(),
  clipEpsilon: z.number().min(0).max(1).optional(),
  entropyCoef: z.number().min(0).max(1).optional(),
  valueCoef: z.number().min(0).max(10).optional(),
  minSamplesForTraining: z.number().int().min(1).max(1_000_000).optional(),
  maxBatchHistory: z.number().int().min(1).max(1_000_000).optional(),
}).strict();

export const TrainingUpdateConfigPayloadSchema = z.object({
  config: TrainingConfigPayloadSchema,
}).strict();

const TrainingOutcomeInputSchema = z.object({
  taskId: z.string().min(1).max(500),
  prompt: z.string().max(500_000),
  response: z.string().max(5_000_000),
  reward: z.number().min(0).max(1),
  strategy: z.string().max(500).optional(),
  context: z.string().max(1_000_000).optional(),
}).strict();

export const TrainingRecordOutcomePayloadSchema = TrainingOutcomeInputSchema;

const StoredTrainingOutcomeSchema = TrainingOutcomeInputSchema.extend({
  timestamp: z.number().int().nonnegative(),
}).strict();

const TrainingBatchSchema = z.object({
  prompts: z.array(z.string().max(500_000)).max(100_000),
  responses: z.array(z.string().max(5_000_000)).max(100_000),
  rewards: z.array(z.number().finite()).max(100_000),
  advantages: z.array(z.number().finite()).max(100_000),
  taskIds: z.array(z.string().min(1).max(500)).max(100_000),
  timestamp: z.number().int().nonnegative(),
}).strict();

export const TrainingImportDataPayloadSchema = z.object({
  outcomes: z.array(StoredTrainingOutcomeSchema).max(1_000_000),
  batches: z.array(TrainingBatchSchema).max(1_000_000),
}).strict();

export const TrainingTopStrategiesPayloadSchema = z.number().int().min(1).max(1_000).optional();

export const TrainingDashboardListPayloadSchema = z.object({
  limit: z.number().int().min(1).max(1_000).optional(),
}).strict().optional();

export const TrainingInsightIdPayloadSchema = z.object({
  insightId: z.string().min(1).max(500),
}).strict();

// ============ Skill Payloads ============

export const SkillsDiscoverPayloadSchema = z.object({
  searchPaths: z.array(DirectoryPathSchema).min(1).max(100),
});

export const SkillsGetPayloadSchema = z.object({
  skillId: z.string().min(1).max(200),
});

export const SkillsLoadPayloadSchema = z.object({
  skillId: z.string().min(1).max(200),
});

export const SkillsUnloadPayloadSchema = z.object({
  skillId: z.string().min(1).max(200),
});

export const SkillsLoadReferencePayloadSchema = z.object({
  skillId: z.string().min(1).max(200),
  referencePath: FilePathSchema,
});

export const SkillsLoadExamplePayloadSchema = z.object({
  skillId: z.string().min(1).max(200),
  examplePath: FilePathSchema,
});

export const SkillsMatchPayloadSchema = z.object({
  text: z.string().min(1).max(1000000),
});

export const SkillsActivationsRecentPayloadSchema = z.object({
  skillName: z.string().min(1).max(200).optional(),
  instanceId: z.string().min(1).max(200).optional(),
  since: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
}).strict().optional();

export const SkillsHealthSummaryPayloadSchema = z.object({
  since: z.number().int().nonnegative().optional(),
}).strict().optional();

export const SkillControlModeSchema = z.enum(['enabled', 'suggest-only', 'disabled']);

export const SkillsSetControlPayloadSchema = z.object({
  skillName: z.string().min(1).max(200),
  mode: SkillControlModeSchema,
  reason: z.string().max(2000).optional(),
}).strict();

// ============ Unified Model Catalog Payloads ============

/**
 * Payload for the renderer to push CLI-discovered models into the main-process
 * unified catalog.  The renderer runs CLI discovery (dynamic-model-catalog.service);
 * this channel bridges the result into the backend catalog.
 */
export const ModelsCLIPushPayloadSchema = z.object({
  /** Normalised provider namespace (e.g. `copilot`, `cursor`). */
  provider: z.string().min(1).max(100),
  /** Discovered model list. */
  models: z.array(z.object({
    id: RequiredModelIdSchema,
    name: z.string().min(1).max(512),
    tier: z.enum(['fast', 'balanced', 'powerful']),
    pinned: z.boolean().optional(),
    family: z.string().max(100).optional(),
  })).max(500),
});

export const ModelsLocalReviewerQualifyPayloadSchema = z.object({
  selectorId: z.string().min(1).max(4_096).startsWith('lm://'),
  ipcAuthToken: z.string().optional(),
}).strict();

export const PluginLifecycleEventSchema = z.object({
  pluginId: z.string().min(1).max(200),
}).strict();

export const PluginErrorEventSchema = PluginLifecycleEventSchema.extend({
  error: z.string().min(1).max(10_000),
}).strict();

const CatalogSourceSchema = z.enum([
  'cli-discovered',
  'models-dev',
  'user-custom',
  'catalog-override',
  'local-model',
  'static',
]);

export const ModelsCatalogUpdatedEventSchema = z.object({
  totalEntries: z.number().int().nonnegative(),
  sources: z.array(CatalogSourceSchema).max(6),
}).strict();

const LocalModelInventoryEntrySchema = z.object({
  selectorId: z.string().min(1).max(4_096).startsWith('lm://'),
  source: z.enum(['this-device', 'worker-node']),
  endpointProvider: z.enum(['ollama', 'openai-compatible']),
  endpointId: z.string().min(1).max(500),
  modelId: RequiredModelIdSchema,
  displayName: z.string().min(1).max(1_000),
  nodeId: z.string().min(1).max(500).optional(),
  nodeName: z.string().min(1).max(500).optional(),
  platform: z.string().min(1).max(100).optional(),
  healthy: z.boolean(),
  loaded: z.boolean(),
  loadedContextLength: z.number().int().nonnegative().optional(),
  advertisedContextLength: z.number().int().nonnegative().optional(),
  capabilities: z.object({
    streaming: z.boolean(),
    multiTurn: z.boolean(),
    toolUse: z.enum(['none', 'probable', 'verified']),
    vision: z.enum(['unknown', 'no', 'yes']),
  }).strict(),
  discoveredAt: z.number().int().nonnegative(),
}).strict();

export const ModelsLocalInventoryUpdatedEventSchema = z.object({
  models: z.array(LocalModelInventoryEntrySchema).max(10_000),
}).strict();

// ============ Ecosystem Payloads ============

export const EcosystemListPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});
