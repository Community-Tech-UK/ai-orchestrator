import { z } from 'zod';
import {
  DirectoryPathSchema,
  FilePathSchema,
  WorkingDirectorySchema,
} from './common.schemas';

// ============ Provider & Plugin Payloads ============

export const ProviderStatusPayloadSchema = z.object({
  providerType: z.string().min(1).max(50),
  forceRefresh: z.boolean().optional(),
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
  model: z.string().max(200).optional(),
});

export const LLMTruncateTokensPayloadSchema = z.object({
  text: z.string().max(10000000),
  maxTokens: z.number().int().min(1).max(1000000),
  model: z.string().max(200).optional(),
});

export const LLMSetConfigPayloadSchema = z.object({
  anthropicApiKey: z.string().max(500).optional(),
  openaiApiKey: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
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
}).optional();

export const TrainingUpdateConfigPayloadSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

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

// ============ Ecosystem Payloads ============

export const EcosystemListPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});
